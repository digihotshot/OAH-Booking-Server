import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

// Import provider data
import { providers } from './src/data/provider.js';
// Mock data no longer needed - using real Zenoti API data

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper functions
const getProvidersByZipcode = (zipcode) => {
  return providers.filter(provider => 
    provider.status === 'active' && 
    provider.zipCodes.includes(zipcode)
  ).sort((a, b) => a.priority - b.priority);
};

// Week-based date generation helper functions
const getWeekDates = (weeks = 4) => {
  const today = new Date();
  const weekDates = [];

  const todayUTC = new Date(Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate()
  ));

  const currentWeekStart = new Date(todayUTC);
  currentWeekStart.setUTCDate(todayUTC.getUTCDate() - todayUTC.getUTCDay());

  for (let week = 0; week < weeks; week++) {
    const weekStartDate = new Date(currentWeekStart);
    weekStartDate.setUTCDate(currentWeekStart.getUTCDate() + (week * 7));

    weekDates.push({
      week: week + 1,
      weekName: week === 0 ? 'Current Week' : `Week ${week + 1}`,
      date: weekStartDate.toISOString().split('T')[0],
      isCurrentWeek: week === 0
    });
  }

  return weekDates;
};

const generateWeekBasedDates = (weeks = 4) => {
  const weekDates = getWeekDates(weeks);
  return weekDates.map(week => week.date);
};

const getWeekStartDate = (dateStr) => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return dateStr;
  }

  const weekStart = new Date(date);
  weekStart.setUTCDate(date.getUTCDate() - date.getUTCDay());

  return weekStart.toISOString().split('T')[0];
};

const getAllProviders = () => {
  return providers.filter(provider => provider.status === 'active')
    .sort((a, b) => a.priority - b.priority);
};

const getProviderById = (providerId) => {
  return providers.find(provider => provider.provider_id === providerId);
};

// Mock data helper functions removed - using real Zenoti API data


// Caching layer for Zenoti API responses
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Concurrency helpers
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const createSemaphore = (maxConcurrency = 8) => {
  let activeCount = 0;
  const queue = [];

  const runNext = () => {
    if (activeCount >= maxConcurrency) {
      return;
    }
    const nextTask = queue.shift();
    if (!nextTask) {
      return;
    }
    activeCount++;
    nextTask()
      .finally(() => {
        activeCount--;
        runNext();
      });
  };

  const run = (task) => {
    return new Promise((resolve, reject) => {
      const execute = () => Promise.resolve().then(task).then(resolve).catch(reject);
      queue.push(execute);
      runNext();
    });
  };

  return { run };
};

const requestSemaphore = createSemaphore(8);

const rateLimitTracker = {
  retryDelays: [1000, 2000, 5000, 10000], // Progressive backoff
  maxRetries: 4
};

// Rate limiting and retry logic

const getCachedData = (key) => {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
};

const setCachedData = (key, data) => {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
};

// Rate limiting helper
// Retry logic with exponential backoff
const makeZenotiRequest = async (requestFn, retryCount = 0) => {
  try {
    const response = await requestSemaphore.run(() => requestFn());
    return response;
  } catch (error) {
    // Handle rate limit errors (429)
    if (error.response && error.response.status === 429) {
      if (retryCount < rateLimitTracker.maxRetries) {
        const delay = rateLimitTracker.retryDelays[retryCount] || 10000;
        console.log(`Rate limited. Retrying in ${delay}ms (attempt ${retryCount + 1}/${rateLimitTracker.maxRetries})`);
        
        // Extract retry-after header if available
        const retryAfter = error.response.headers['retry-after'];
        const actualDelay = retryAfter ? parseInt(retryAfter) * 1000 : delay;
        
        if (actualDelay > 0) {
          await sleep(actualDelay);
        }
        return makeZenotiRequest(requestFn, retryCount + 1);
      } else {
        console.error(`Max retries (${rateLimitTracker.maxRetries}) exceeded for rate limited request`);
        throw new Error('Rate limit exceeded. Please try again later.');
      }
    }
    
    // Re-throw non-rate-limit errors
    throw error;
  }
};

class ApiValidationError extends Error {
  constructor(message, statusCode = 400, details = null) {
    super(message);
    this.name = 'ApiValidationError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

const getZenotiConfig = () => {
  const zenotiApiKey = process.env.ZENOTI_API_KEY;
  const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';

  if (!zenotiApiKey) {
    throw new Error('Zenoti API key not configured');
  }

  return { zenotiApiKey, zenotiBaseUrl };
};

const sanitizePhoneForZenoti = (phone) => {
  if (!phone) {
    throw new ApiValidationError('phone number is required', 400);
  }

  const digits = String(phone).replace(/\D/g, '');
  if (!digits) {
    throw new ApiValidationError('phone number must contain digits', 400);
  }

  let zenotiDigits = digits;
  if (digits.length === 10) {
    zenotiDigits = digits.substring(1);
  } else if (digits.length !== 9) {
    throw new ApiValidationError('phone number must be 9 or 10 digits', 400);
  }

  return {
    original: digits,
    zenoti: zenotiDigits
  };
};

const resolveGuestNames = ({ name, firstName, lastName }) => {
  let resolvedFirstName = firstName ? String(firstName).trim() : '';
  let resolvedLastName = lastName ? String(lastName).trim() : '';

  if (!resolvedFirstName) {
    const combinedName = name ? String(name).trim() : '';
    if (combinedName) {
      const parts = combinedName.split(/\s+/);
      resolvedFirstName = parts.shift();
      const remaining = parts.join(' ');
      if (!resolvedLastName && remaining) {
        resolvedLastName = remaining;
      }
    }
  }

  if (!resolvedFirstName) {
    throw new ApiValidationError('guest first name is required', 400);
  }

  if (!resolvedLastName) {
    resolvedLastName = '';
  }

  return {
    firstName: resolvedFirstName,
    lastName: resolvedLastName
  };
};

const createGuestInZenoti = async ({ centerId, name, firstName, lastName, email, phone }) => {
  if (!centerId) {
    throw new ApiValidationError('center_id (provider_id) is required', 400);
  }

  if (!email) {
    throw new ApiValidationError('email is required', 400);
  }

  const { firstName: resolvedFirstName, lastName: resolvedLastName } = resolveGuestNames({
    name,
    firstName,
    lastName
  });

  const { original: sanitizedPhone, zenoti: phoneForZenoti } = sanitizePhoneForZenoti(phone);

  const guestPayload = {
    center_id: centerId,
    personal_info: {
      first_name: resolvedFirstName,
      last_name: resolvedLastName,
      email,
      mobile_phone: {
        country_code: '+1',
        number: phoneForZenoti
      }
    }
  };

  const { zenotiApiKey, zenotiBaseUrl } = getZenotiConfig();

  const response = await makeZenotiRequest(async () => {
    return await axios.post(`${zenotiBaseUrl}/guests`, guestPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `apikey ${zenotiApiKey}`
      }
    });
  });

  return {
    data: response.data,
    payload: guestPayload,
    sanitizedPhone,
    phoneForZenoti,
    resolvedFirstName,
    resolvedLastName
  };
};

const createBookingInZenoti = async ({ centerId, date, guestId, serviceIds }) => {
  if (!centerId) {
    throw new ApiValidationError('center_id (provider_id) is required', 400);
  }

  if (!date) {
    throw new ApiValidationError('date is required', 400);
  }

  if (!guestId) {
    throw new ApiValidationError('guest_id is required', 400);
  }

  if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
    throw new ApiValidationError('service_ids must be a non-empty array', 400);
  }

  const normalizedDate = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(normalizedDate.getTime())) {
    throw new ApiValidationError('date must be a valid YYYY-MM-DD string', 400);
  }

  const items = serviceIds.map((serviceId, index) => {
    if (!serviceId || (typeof serviceId !== 'string' && typeof serviceId !== 'number')) {
      const error = new ApiValidationError(
        'service_ids must only contain service IDs. For multiple treatments, use one entry per service ID.',
        400,
        {
          index,
          service_input: serviceId,
          service_ids_type: serviceIds.map((value) => typeof value)
        }
      );

    /*
    TODO: Once logging infrastructure is in place, add a structured log (e.g. to pino) here with:
        {
          error: error.message,
          details: error.details,
          center_id: centerId,
          guest_id: guestId,
          date
        }
    so we can trace payload issues in prod without exposing them to the client.
    */

      throw error;
    }

    return {
      item: { id: String(serviceId).trim() }
    };
  });

  const bookingPayload = {
    center_id: centerId,
    date: normalizedDate.toISOString().split('T')[0],
    guests: [
      {
        id: guestId,
      items
      }
    ]
  };

  const { zenotiApiKey, zenotiBaseUrl } = getZenotiConfig();

  try {
    console.log('[createBookingInZenoti] Request payload', bookingPayload);

    const response = await makeZenotiRequest(async () => {
      return await axios.post(`${zenotiBaseUrl}/bookings?is_double_booking_enabled=false`, bookingPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });

    console.log('[createBookingInZenoti] Booking created', {
      bookingId: response.data?.id,
      status: response.status,
      serviceCount: serviceIds.length
    });

    return {
      data: response.data,
      payload: bookingPayload
    };
  } catch (error) {
    if (error.response) {
      console.error('[createBookingInZenoti] Zenoti API responded with error', {
        status: error.response.status,
        data: error.response.data
      });
    } else {
      console.error('[createBookingInZenoti] Failed to create booking', {
        message: error.message
      });
    }

    console.error('[createBookingInZenoti] Payload that caused error', bookingPayload);
    console.error('[createBookingInZenoti] Error response', error.response?.data || error.message);
    throw error;
  }
};

const reserveSlotInZenoti = async ({ bookingId, slotTime, createInvoice = false }) => {
  if (!bookingId) {
    throw new ApiValidationError('bookingId is required', 400);
  }

  if (!slotTime) {
    throw new ApiValidationError('slot_time is required', 400);
  }

  const slotDate = new Date(slotTime);
  if (Number.isNaN(slotDate.getTime())) {
    throw new ApiValidationError('slot_time must be a valid date string', 400);
  }

  // Use the slot_time as-is without timezone conversion
  // Zenoti expects the time in the center's local timezone
  const formattedSlotTime = slotTime;

  const reservePayload = {
    slot_time: formattedSlotTime,
    create_invoice: createInvoice
  };

  const { zenotiApiKey, zenotiBaseUrl } = getZenotiConfig();

  console.log('[reserveSlotInZenoti] Request payload', {
    bookingId,
    reservePayload
  });

  try {
    const response = await makeZenotiRequest(async () => {
      return await axios.post(`${zenotiBaseUrl}/bookings/${bookingId}/slots/reserve`, reservePayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });

    console.log('[reserveSlotInZenoti] Reservation created', {
      bookingId,
      slot_time: formattedSlotTime,
      status: response.status
    });

    return {
      data: response.data,
      payload: reservePayload,
      formattedSlotTime
    };
  } catch (error) {
    if (error.response) {
      console.error('[reserveSlotInZenoti] Zenoti API responded with error', {
        status: error.response.status,
        data: error.response.data
      });
    } else {
      console.error('[reserveSlotInZenoti] Failed to reserve slot', {
        message: error.message
      });
    }

    throw error;
  }
};

// Zenoti API helper functions
const fetchZenotiServices = async (centerId, categoryId = null) => {
  const zenotiApiKey = process.env.ZENOTI_API_KEY;
  const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com';
  
  if (!zenotiApiKey) {
    throw new Error('Zenoti API key not configured');
  }
  
  let url = `${zenotiBaseUrl}/centers/${centerId}/services?catalog_enabled=true`;
  if (categoryId) {
    url += `&category_id=${categoryId}`;
  }
  
  try {
    const response = await makeZenotiRequest(async () => {
      return await axios.get(url, {
        headers: {
          'Authorization': `apikey ${zenotiApiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
    });
    
    return response.data;
  } catch (error) {
    console.error(`Zenoti API error for center ${centerId}:`, error.message);
    throw new Error(`Failed to fetch services from Zenoti API: ${error.message}`);
  }
};

const fetchZenotiCategories = async (centerId) => {
  const zenotiApiKey = process.env.ZENOTI_API_KEY;
  const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com';
  
  if (!zenotiApiKey) {
    throw new Error('Zenoti API key not configured');
  }
  
  try {
    const response = await makeZenotiRequest(async () => {
      return await axios.get(`${zenotiBaseUrl}/centers/${centerId}/categories?show_in_catalog=true`, {
        headers: {
          'Authorization': `apikey ${zenotiApiKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
    });
    
    return response.data;
  } catch (error) {
    console.error(`Zenoti API error for categories at center ${centerId}:`, error.message);
    throw new Error(`Failed to fetch categories from Zenoti API for center ${centerId}: ${error.message}`);
  }
};

const aggregateCategoriesWithServicesFromAllCenters = async (centerIds) => {
  const allCategories = [];
  const categoryMap = new Map(); // To deduplicate categories across centers
  const serviceMap = new Map(); // To deduplicate services across centers
  
  // First, fetch categories from all centers
  const centerPromises = centerIds.map(async (centerId) => {
    try {
      const categoriesData = await fetchZenotiCategories(centerId);
      return {
        centerId,
        categories: categoriesData.categories || []
      };
    } catch (error) {
      console.error(`Failed to fetch categories for center ${centerId}:`, error.message);
      return {
        centerId,
        categories: []
      };
    }
  });
  
  // Wait for all centers to complete
  const centerResults = await Promise.all(centerPromises);
  
  // Process categories first
  centerResults.forEach(({ centerId, categories }) => {
    categories.forEach(category => {
      const categoryKey = category.id;
      
      if (!categoryMap.has(categoryKey)) {
        const aggregatedCategory = {
          ...category,
          available_centers: [centerId],
          services: []
        };
        
        categoryMap.set(categoryKey, aggregatedCategory);
        allCategories.push(aggregatedCategory);
      } else {
        const existingCategory = categoryMap.get(categoryKey);
        if (!existingCategory.available_centers.includes(centerId)) {
          existingCategory.available_centers.push(centerId);
        }
      }
    });
  });
  
  // Now fetch services for each category from each center
  const servicePromises = [];
  centerIds.forEach(centerId => {
    allCategories.forEach(category => {
      const promise = fetchZenotiServices(centerId, category.id)
        .then(servicesData => ({
          centerId,
          categoryId: category.id,
          services: servicesData.services || []
        }))
        .catch(error => {
          console.error(`Failed to fetch services for center ${centerId}, category ${category.id}:`, error.message);
          return {
            centerId,
            categoryId: category.id,
            services: []
          };
        });
      
      servicePromises.push(promise);
    });
  });
  
  // Wait for all service requests to complete
  const serviceResults = await Promise.all(servicePromises);
  
  // Process services and group them under categories
  serviceResults.forEach(({ centerId, categoryId, services }) => {
    const category = categoryMap.get(categoryId);
    if (category) {
      services.forEach(service => {
        const serviceKey = service.id;
        
        // Check if service is already in this category
        const existingService = category.services.find(s => s.id === serviceKey);
        if (!existingService) {
          // Add service to category
          const serviceData = {
            id: service.id,
            name: service.name,
            description: service.description,
            duration: service.duration,
            price: service.price_info?.final_price || service.price_info?.sale_price || 0,
            code: service.code,
            available_centers: [centerId]
          };
          
          category.services.push(serviceData);
        } else {
          // Add center to existing service's available_centers
          if (!existingService.available_centers.includes(centerId)) {
            existingService.available_centers.push(centerId);
          }
        }
      });
    }
  });
  
  // Sort categories by display_order (1 to highest)
  allCategories.sort((a, b) => {
    const orderA = parseInt(a.display_order) || 999;
    const orderB = parseInt(b.display_order) || 999;
    return orderA - orderB;
  });
  
  // Sort services within each category by name
  allCategories.forEach(category => {
    category.services.sort((a, b) => a.name.localeCompare(b.name));
  });
  
  return { categories: allCategories };
};

// Google Places API helper functions
const getGooglePlacesSuggestions = async (input) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  
  if (!apiKey) {
    throw new Error('Google Places API key not configured');
  }
  
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
      params: {
        input: input,
        key: apiKey,
        types: 'address',
        components: 'country:us'
      }
    });
    
    return response.data.predictions.map(prediction => ({
      placeId: prediction.place_id,
      description: prediction.description,
      mainText: prediction.structured_formatting.main_text,
      secondaryText: prediction.structured_formatting.secondary_text
    }));
  } catch (error) {
    console.error('Google Places API error:', error.message);
    throw new Error('Failed to fetch address suggestions');
  }
};

const getPlaceDetails = async (placeId) => {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  
  if (!apiKey) {
    throw new Error('Google Places API key not configured');
  }
  
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        key: apiKey,
        fields: 'address_components,formatted_address,geometry'
      }
    });
    
    const result = response.data.result;
    const addressComponents = result.address_components || [];
    
    // Extract address components
    const zipcode = addressComponents.find(comp => 
      comp.types.includes('postal_code')
    )?.long_name || '';
    
    const city = addressComponents.find(comp => 
      comp.types.includes('locality') || comp.types.includes('administrative_area_level_2')
    )?.long_name || '';
    
    const state = addressComponents.find(comp => 
      comp.types.includes('administrative_area_level_1')
    )?.long_name || '';
    
    const country = addressComponents.find(comp => 
      comp.types.includes('country')
    )?.long_name || 'US';
    
    return {
      placeId: placeId,
      formattedAddress: result.formatted_address,
      zipcode: zipcode,
      city: city,
      state: state,
      country: country,
      coordinates: result.geometry?.location || null
    };
  } catch (error) {
    console.error('Google Places Details API error:', error.message);
    throw new Error('Failed to fetch place details');
  }
};

// Routes

// Provider routes
app.get('/api/providers', (req, res) => {
  try {
    const allProviders = getAllProviders();
    res.json({
      success: true,
      data: allProviders,
      message: `Found ${allProviders.length} providers`,
      total: allProviders.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/providers/zipcode/:zipcode', (req, res) => {
  try {
    const { zipcode } = req.params;
    const providers = getProvidersByZipcode(zipcode);
    
    // Return providers with their IDs for frontend to use
    const cleanProviders = providers.map(provider => ({
      name: provider.name,
      provider_id: provider.provider_id,
      status: provider.status,
      priority: provider.priority
    }));
    
    res.json({
      success: true,
      data: cleanProviders,
      message: `Found ${cleanProviders.length} providers for zipcode ${zipcode}`,
      zipcode,
      count: cleanProviders.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/providers/:providerId', (req, res) => {
  try {
    const { providerId } = req.params;
    const provider = getProviderById(providerId);
    
    if (!provider) {
      res.status(404).json({
        success: false,
        error: 'Provider not found'
      });
      return;
    }
    
    res.json({
      success: true,
      data: provider,
      message: 'Provider found'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Google Places API routes
app.get('/api/address/suggestions', async (req, res) => {
  try {
    const { input } = req.query;
    
    if (!input || input.trim().length < 3) {
      res.status(400).json({
        success: false,
        error: 'Input query parameter is required (minimum 3 characters)'
      });
      return;
    }
    
    const suggestions = await getGooglePlacesSuggestions(input);
    
    res.json({
      success: true,
      data: suggestions,
      message: `Found ${suggestions.length} address suggestions`,
      input: input
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/address/validate', async (req, res) => {
  try {
    const { placeId } = req.body;
    
    if (!placeId) {
      res.status(400).json({
        success: false,
        error: 'Place ID is required'
      });
      return;
    }
    
    const addressDetails = await getPlaceDetails(placeId);
    
    res.json({
      success: true,
      data: addressDetails,
      message: 'Address validated successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Address lookup
app.post('/api/address/centers', (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address || !address.zipcode) {
      res.status(400).json({
        success: false,
        error: 'Valid address with zipcode is required'
      });
      return;
    }
    
    const providers = getProvidersByZipcode(address.zipcode);
    
    // Convert to center format (without zipcodes and id for cleaner response)
    const centers = providers.map(provider => ({
      name: provider.name,
      priority: provider.priority,
      status: provider.status,
      address: {
        zipcode: address.zipcode,
        city: address.city || '',
        state: address.state || '',
        country: address.country || 'US'
      }
    }));
    
    res.json({
      success: true,
      data: centers,
      message: `Found ${centers.length} provider(s) serving this area`,
      zipcode: address.zipcode,
      count: centers.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});






// Booking Slots endpoints (Real Zenoti Data)

// Create a booking to get booking ID (supports multiple services)
const createZenotiBooking = async (centerId, date, serviceIds) => {
  const zenotiApiKey = process.env.ZENOTI_API_KEY;
  const zenotiBaseUrl = process.env.ZENOTI_BASE_URL;
  
  if (!zenotiApiKey) {
    throw new Error('Zenoti API key not configured');
  }

  // Convert single serviceId to array for consistency
  const services = Array.isArray(serviceIds) ? serviceIds : [serviceIds];
  const cacheKey = `booking-${centerId}-${date}-${services.join(',')}`;
  const cachedData = getCachedData(cacheKey);
  if (cachedData) {
    console.log(`Cache hit for booking: ${centerId}-${date}-${services.join(',')}`);
    return cachedData;
  }

  try {
    // Ensure date is in YYYY-MM-DD format
    const formattedDate = new Date(date).toISOString().split('T')[0];
    
    const bookingPayload = {
      center_id: centerId,
      date: formattedDate,
      guests: [
        {
          id: null,
          items: services.map(serviceId => ({
            item: { id: serviceId }
          }))
        }
      ]
    };
    
    console.log('Booking payload:', JSON.stringify(bookingPayload, null, 2));
    
    const response = await makeZenotiRequest(async () => {
      return await axios.post(`${zenotiBaseUrl}/bookings?is_double_booking_enabled=false`, bookingPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });
    
    setCachedData(cacheKey, response.data, 300000); // 5 minutes cache
    console.log(`Cached booking data for center: ${centerId}, services: ${services.join(',')}`);
    return response.data;
  } catch (error) {
    console.error(`Zenoti API error for booking (center ${centerId}): ${error.message}`);
    if (error.response) {
      console.error('Zenoti API response status:', error.response.status);
      console.error('Zenoti API response data:', error.response.data);
    }
    throw error;
  }
};

// Get available slots for a booking
const fetchZenotiSlots = async (bookingId, checkFutureDayAvailability = false) => {
  const zenotiApiKey = process.env.ZENOTI_API_KEY;
  const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';
  
  if (!zenotiApiKey) {
    throw new Error('Zenoti API key not configured');
  }

  const cacheKey = `slots-${bookingId}-${checkFutureDayAvailability ? 'future' : 'current'}`;
  const cachedData = getCachedData(cacheKey);
  if (cachedData) {
    console.log(`Cache hit for slots: ${bookingId} (future: ${checkFutureDayAvailability})`);
    return cachedData;
  }

  try {
    // Build URL with optional future day availability parameter
    let url = `${zenotiBaseUrl}/bookings/${bookingId}/slots`;
    if (checkFutureDayAvailability) {
      url += '?check_future_day_availability=true';
    }

    const response = await makeZenotiRequest(async () => {
      return await axios.get(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });
    
    setCachedData(cacheKey, response.data, 300000); // 5 minutes cache
    console.log(`Cached slots data for booking: ${bookingId} (future: ${checkFutureDayAvailability})`);
    return response.data;
  } catch (error) {
    console.error(`Zenoti API error for slots (booking ${bookingId}): ${error.message}`);
    throw error;
  }
};

// Helper function to aggregate 15-minute slots into 1-hour buckets
const aggregateSlotsIntoHourlyBuckets = (slots) => {
  const hourlyBuckets = new Map();
  
  slots.forEach(slot => {
    if (!slot.Available) return; // Skip unavailable slots
    
    // Extract time from slot (handles both "09:00:00" and "2025-10-05T09:00:00" formats)
    const timeStr = slot.Time || slot.time || slot.start_time || '';
    if (!timeStr) return;
    
    let hours;
    
    // Check if it's a full ISO datetime string
    if (timeStr.includes('T')) {
      // Extract time part from ISO datetime (e.g., "2025-10-05T12:00:00" -> "12:00:00")
      const timePart = timeStr.split('T')[1];
      if (timePart) {
        hours = parseInt(timePart.split(':')[0], 10);
      } else {
        return; // Invalid format
      }
    } else {
      // Handle time-only format (e.g., "12:00:00" or "12:00")
      const timeParts = timeStr.split(':');
      hours = parseInt(timeParts[0], 10);
    }
    
    // Validate hours (0-23)
    if (isNaN(hours) || hours < 0 || hours > 23) {
      console.warn(`Invalid hour value: ${hours} from time string: ${timeStr}`);
      return;
    }
    
    const hourKey = `${hours.toString().padStart(2, '0')}:00`;
    
    // Initialize bucket if it doesn't exist
    if (!hourlyBuckets.has(hourKey)) {
      hourlyBuckets.set(hourKey, {
        time: hourKey,
        available: true,
        count: 0,
        slots: []
      });
    }
    
    // Add slot to bucket
    const bucket = hourlyBuckets.get(hourKey);
    bucket.count++;
    bucket.slots.push(slot);
  });
  
  // Convert Map to sorted array
  return Array.from(hourlyBuckets.values())
    .sort((a, b) => a.time.localeCompare(b.time));
};

// Helper function to select best provider for a slot based on priority
const selectBestProviderForSlot = (slotTime, availableCenters) => {
  // If no centers provided, return null
  if (!availableCenters || availableCenters.length === 0) {
    console.log(`No centers provided for slot: ${slotTime}`);
    return null;
  }
  
  // Sort centers by priority (lowest number = highest priority)
  const sortedCenters = availableCenters.sort((a, b) => a.priority - b.priority);
  
  if (sortedCenters.length === 1) {
    const provider = sortedCenters[0];
    console.log(`Single provider available for slot ${slotTime}: ${provider.centerName} (Priority: ${provider.priority})`);
    return {
      centerId: provider.centerId,
      centerName: provider.centerName,
      priority: provider.priority,
      isFallback: false,
      totalOptions: 1
    };
  }
  
  // Multiple providers - select highest priority (first in sorted array)
  const selectedProvider = sortedCenters[0];
  const isFallback = false; // First provider is always primary
  
  console.log(`Provider selection for slot ${slotTime}: ${selectedProvider.centerName} (Priority: ${selectedProvider.priority}) [PRIMARY]`);
  
  return {
    centerId: selectedProvider.centerId,
    centerName: selectedProvider.centerName,
    priority: selectedProvider.priority,
    isFallback: isFallback,
    totalOptions: sortedCenters.length
  };
};

// Helper function to merge hourly slots across multiple centers
const mergeHourlySlotsAcrossCenters = (hourlySlotsArray) => {
  const mergedBuckets = new Map();
  
  hourlySlotsArray.forEach(hourlySlot => {
    const timeKey = hourlySlot.time;
    
    if (!mergedBuckets.has(timeKey)) {
      mergedBuckets.set(timeKey, {
        time: timeKey,
        available: true,
        count: 0,
        centers: []
      });
    }
    
    const bucket = mergedBuckets.get(timeKey);
    bucket.count += hourlySlot.count;
    bucket.centers.push({
      slots: hourlySlot.slots,
      count: hourlySlot.count
    });
  });
  
  // Convert Map to sorted array
  return Array.from(mergedBuckets.values())
    .sort((a, b) => a.time.localeCompare(b.time));
};

// Create booking endpoint (supports single or multiple centers and services)
app.post('/api/bookings', async (req, res) => {
  try {
    const { centerId, centers, date, serviceId, serviceIds } = req.body;
    
    if (!date) {
      res.status(400).json({
        success: false,
        error: 'date is required'
      });
      return;
    }
    
    // Support both single serviceId and multiple serviceIds
    let services = [];
    if (serviceIds && Array.isArray(serviceIds) && serviceIds.length > 0) {
      services = serviceIds;
    } else if (serviceId) {
      services = [serviceId];
    } else {
      res.status(400).json({
        success: false,
        error: 'Either serviceId or serviceIds array is required'
      });
      return;
    }
    
    // Determine if single center or multiple centers
    let targetCenters = [];
    if (centers && Array.isArray(centers) && centers.length > 0) {
      // Multiple centers
      targetCenters = centers;
    } else if (centerId) {
      // Single center
      targetCenters = [centerId];
    } else {
      res.status(400).json({
        success: false,
        error: 'Either centerId or centers array is required'
      });
      return;
    }
    
    // If single center, return the original format for backward compatibility
    if (targetCenters.length === 1) {
      const bookingData = await createZenotiBooking(targetCenters[0], date, services);
      
      res.json({
        success: true,
        data: bookingData,
        message: `Booking created for ${services.length} service(s) on ${date}`,
        services: services
      });
      return;
    }
    
    // Multiple centers - create bookings for all centers in parallel
    console.log(`🎯 Creating bookings for ${targetCenters.length} centers on ${date}`);
    
    const bookingPromises = targetCenters.map(async (centerId) => {
      try {
        const bookingData = await createZenotiBooking(centerId, date, services);
        
        // Get provider information
        const provider = getProviderById(centerId);
        
        return {
          centerId,
          centerName: provider?.name || 'Unknown Provider',
          priority: provider?.priority || 999,
          bookingId: bookingData.id,
          bookingData,
          success: true,
          error: null
        };
      } catch (error) {
        console.error(`Failed to create booking for center ${centerId}:`, error.message);
        
        // Get provider information even for failed bookings
        const provider = getProviderById(centerId);
        
        return {
          centerId,
          centerName: provider?.name || 'Unknown Provider',
          priority: provider?.priority || 999,
          bookingId: null,
          bookingData: null,
          success: false,
          error: error.message
        };
      }
    });
    
    const bookingResults = await Promise.all(bookingPromises);
    
    // Separate successful and failed bookings
    const successfulBookings = bookingResults.filter(result => result.success);
    const failedBookings = bookingResults.filter(result => !result.success);
    
    // Sort by priority (lowest number = highest priority)
    successfulBookings.sort((a, b) => a.priority - b.priority);
    
    console.log(`✅ Created ${successfulBookings.length} successful bookings, ${failedBookings.length} failed`);
    
    res.json({
      success: true,
      data: {
        bookings: bookingResults,
        successfulBookings: successfulBookings,
        failedBookings: failedBookings,
        summary: {
          totalCenters: targetCenters.length,
          successful: successfulBookings.length,
          failed: failedBookings.length,
          date,
          services
        }
      },
      message: `Created bookings for ${successfulBookings.length}/${targetCenters.length} centers on ${date}`,
      date,
      services
    });

  } catch (error) {
    console.error(`Error creating bookings:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      date: req.body.date,
      centers: req.body.centers || req.body.centerId
    });
  }
});

// Get slots for a specific booking
app.get('/api/bookings/:bookingId/slots', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { check_future_day_availability } = req.query;
    
    // Convert query parameter to boolean (default to true for future dates)
    const includeFutureDays = check_future_day_availability !== 'false';
    
    const slotsData = await fetchZenotiSlots(bookingId, includeFutureDays);
    
    res.json({
      success: true,
      data: slotsData,
      message: `Retrieved slots for booking ${bookingId}${includeFutureDays ? ' (including future days)' : ' (current day only)'}`,
      check_future_day_availability: includeFutureDays
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Unified slots endpoint for multiple centers and services (week-based selection only)
app.post('/api/slots/unified', async (req, res) => {
  try {
    const { centers, services, weeks = 4 } = req.body;
    
    if (!centers || !Array.isArray(centers) || centers.length === 0) {
      res.status(400).json({
        success: false,
        error: 'centers array is required'
      });
      return;
    }
    
    if (!services || !Array.isArray(services) || services.length === 0) {
      res.status(400).json({
        success: false,
        error: 'services array is required'
      });
      return;
    }
    
    // Always operate in week-based mode using Sunday as the week start
    const weekDates = getWeekDates(weeks);
    let targetDates = weekDates.map(week => week.date);
    const weekInfo = weekDates;
    console.log(`🗓️ Week-based mode: Generated ${targetDates.length} week start dates for ${weeks} weeks`);
    
    // Limit to 28 days (4 weeks) from current date
    const now = new Date();
    const todayStartUTC = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));
    const currentWeekStartDateStr = weekDates[0]?.date;
    const currentWeekStartDate = currentWeekStartDateStr
      ? new Date(`${currentWeekStartDateStr}T00:00:00Z`)
      : todayStartUTC;
    const maxDate = new Date(todayStartUTC.getTime() + (28 * 24 * 60 * 60 * 1000)); // 28 days from today (inclusive)
    
    // Filter dates to only include those within 28 days
    targetDates = targetDates.filter(dateStr => {
      const date = new Date(`${dateStr}T00:00:00Z`);
      return date >= currentWeekStartDate && date <= maxDate;
    });
    
    if (targetDates.length === 0) {
      res.status(400).json({
        success: false,
        error: 'No valid week start dates within 28-day range from today'
      });
      return;
    }

    // Process specific dates
    console.log(`🚀 Processing week start dates: ${targetDates.length} dates for ${centers.length} centers`);
    const startTime = Date.now();

    // Create all booking combinations in parallel for all dates
    const bookingPromises = [];
    const bookingMap = new Map(); // To track which booking belongs to which center/service/date
    const bookingKeyFor = (centerId, dateStr) => `${centerId}::${dateStr}`;
    const centerDateBookingMap = new Map();
    
    centers.forEach(centerId => {
      targetDates.forEach(date => {
        // Create a single booking with all services for this center and date
        const promise = createZenotiBooking(centerId, date, services)
          .then(bookingData => {
            if (bookingData.id && !bookingData.error) {
              bookingMap.set(bookingData.id, { centerId, services, date, bookingData });
              centerDateBookingMap.set(bookingKeyFor(centerId, date), bookingData.id);
              return { bookingId: bookingData.id, centerId, services, date, bookingData };
            }
            return { bookingId: null, centerId, services, date, error: bookingData.error };
          })
          .catch(error => {
            console.log(`Failed to create booking for center ${centerId}, services ${services.join(',')}, date ${date}: ${error.message}`);
            return { bookingId: null, centerId, services, date, error: error.message };
          });
        
        bookingPromises.push(promise);
      });
    });

    const bookingResults = await Promise.all(bookingPromises);
    
    // Filter successful bookings
    const successfulBookings = bookingResults.filter(result => result.bookingId);
    
    if (successfulBookings.length === 0) {
      res.json({
        success: true,
        data: {
          centers: centers,
          services: services,
          dates: targetDates,
          // Week-based information
          week_info: weekInfo,
          mode: 'week_based',
          total_combinations: bookingResults.length,
          successful_combinations: 0,
          available_dates: [],
          weekly_availability: []
        },
        message: `No successful bookings created for ${weeks} weeks (${targetDates.length} dates)`
      });
      return;
    }

    // Fetch slots for all successful bookings in parallel
    const initialSlotsResults = await Promise.all(successfulBookings.map(async ({ bookingId, centerId, services, date }) => {
      try {
        const slotsData = await fetchZenotiSlots(bookingId, true);
        return {
          centerId,
          services,
          date,
          bookingId,
          slots: slotsData.slots || [],
          futureDays: slotsData.future_days || slotsData.futureDays || [],
          nextAvailableDay: slotsData.next_available_day || slotsData.nextAvailableDay || null,
          error: slotsData.Error,
          discoveredFromDates: [date],
          discoveredFromBookingIds: [bookingId],
          isFutureBooking: false,
          sourceBookingId: bookingId,
          sourceBookingDate: date
        };
      } catch (error) {
        console.log(`Failed to fetch slots for booking ${bookingId}: ${error.message}`);
        return {
          centerId,
          services,
          date,
          bookingId,
          slots: [],
          futureDays: [],
          nextAvailableDay: null,
          error: error.message,
          discoveredFromDates: [date],
          discoveredFromBookingIds: [bookingId],
          isFutureBooking: false,
          sourceBookingId: bookingId,
          sourceBookingDate: date
        };
      }
    }));

    const allSlotsResults = [];
    const resultQueue = [...initialSlotsResults];
    const futureBookingQueue = [];
    const futureBookingsCreated = [];
    const futureBookingFailures = [];
    const processedCenterDates = new Set();
    const pendingFutureBookingKeys = new Set();

    const futureDayAvailabilityMap = new Map();
    const futureDayBookingMap = new Map();
    const slotsByBookingId = new Map();

    const registerFutureAvailability = (centerId, dateStr) => {
      if (!dateStr) {
        return;
      }
      if (!futureDayAvailabilityMap.has(centerId)) {
        futureDayAvailabilityMap.set(centerId, new Set());
      }
      futureDayAvailabilityMap.get(centerId).add(dateStr);
    };

    const recordFutureBookingMap = (centerId, dateStr, bookingId) => {
      if (!bookingId) {
        return;
      }
      if (!futureDayBookingMap.has(centerId)) {
        futureDayBookingMap.set(centerId, new Map());
      }
      futureDayBookingMap.get(centerId).set(dateStr, bookingId);
    };

    const futureBookingKeyFor = (centerId, dateStr) => `${centerId}::${dateStr}`;

    const enqueueFutureBooking = ({ centerId, services, futureDate, discoveredFromBookingId, discoveredFromDate, discoveryTrailDates, discoveryTrailBookingIds }) => {
      if (!futureDate) {
        return;
      }
      const key = futureBookingKeyFor(centerId, futureDate);
      if (processedCenterDates.has(key) || pendingFutureBookingKeys.has(key) || centerDateBookingMap.has(key)) {
        return;
      }
      pendingFutureBookingKeys.add(key);
      futureBookingQueue.push({
        centerId,
        services,
        date: futureDate,
        discoveredFromBookingId,
        discoveredFromDate,
        discoveryTrailDates,
        discoveryTrailBookingIds
      });
    };

    while (resultQueue.length > 0) {
      const currentResult = resultQueue.shift();
      const {
        centerId,
        services,
        date,
        bookingId,
        slots,
        futureDays,
        nextAvailableDay,
        error,
        discoveredFromDates = [date],
        discoveredFromBookingIds = bookingId ? [bookingId] : [],
        isFutureBooking = false,
        sourceBookingId,
        sourceBookingDate
      } = currentResult;

      const centerDateKey = futureBookingKeyFor(centerId, date);

      allSlotsResults.push({
        centerId,
        services,
        date,
        bookingId,
        slots,
        futureDays,
        nextAvailableDay,
        error,
        discoveredFromDates,
        discoveredFromBookingIds,
        isFutureBooking,
        sourceBookingId,
        sourceBookingDate
      });

      processedCenterDates.add(centerDateKey);
      pendingFutureBookingKeys.delete(centerDateKey);

      if (bookingId) {
        centerDateBookingMap.set(centerDateKey, bookingId);
        recordFutureBookingMap(centerId, date, bookingId);
      }

      const futureAvailableDates = Array.isArray(futureDays)
        ? futureDays
            .filter(day => (day?.IsAvailable ?? day?.isAvailable) === true)
            .map(day => {
              const rawDay = day?.Day || day?.day || day?.date;
              if (!rawDay) {
                return null;
              }
              return rawDay.split('T')[0];
            })
            .filter(Boolean)
        : [];

      futureAvailableDates.forEach(futureDate => {
        registerFutureAvailability(centerId, futureDate);
        const updatedTrailDates = [...discoveredFromDates, futureDate];
        const updatedTrailBookingIds = [...discoveredFromBookingIds];
        if (bookingId && !updatedTrailBookingIds.includes(bookingId)) {
          updatedTrailBookingIds.push(bookingId);
        }
        enqueueFutureBooking({
          centerId,
          services,
          futureDate,
          discoveredFromBookingId: bookingId,
          discoveredFromDate: date,
          discoveryTrailDates: updatedTrailDates,
          discoveryTrailBookingIds: updatedTrailBookingIds
        });
      });

      if (resultQueue.length === 0 && futureBookingQueue.length > 0) {
        const bookingsToProcess = futureBookingQueue.splice(0);
    const futureResults = await Promise.all(bookingsToProcess.map(async item => {
          const {
            centerId: futureCenterId,
            services: futureServices,
            date: futureDate,
            discoveredFromBookingId,
            discoveredFromDate,
            discoveryTrailDates,
            discoveryTrailBookingIds
          } = item;
          const futureKey = futureBookingKeyFor(futureCenterId, futureDate);

          try {
            const bookingData = await createZenotiBooking(futureCenterId, futureDate, futureServices);
            if (!bookingData?.id) {
              futureBookingFailures.push({
                centerId: futureCenterId,
                date: futureDate,
                services: futureServices,
                discoveredFromBookingId,
                discoveredFromDate,
                error: bookingData?.error || 'Unknown error creating future booking'
              });
              pendingFutureBookingKeys.delete(futureKey);
              return null;
            }

            bookingMap.set(bookingData.id, { centerId: futureCenterId, services: futureServices, date: futureDate, bookingData });
            centerDateBookingMap.set(futureKey, bookingData.id);

            const slotsData = await fetchZenotiSlots(bookingData.id, true);

            const result = {
              centerId: futureCenterId,
              services: futureServices,
              date: futureDate,
              bookingId: bookingData.id,
              slots: slotsData.slots || [],
              futureDays: slotsData.future_days || slotsData.futureDays || [],
              nextAvailableDay: slotsData.next_available_day || slotsData.nextAvailableDay || null,
              error: slotsData.Error,
              discoveredFromDates: discoveryTrailDates.length > 0 ? discoveryTrailDates : [futureDate],
              discoveredFromBookingIds: discoveryTrailBookingIds.length > 0 ? discoveryTrailBookingIds : (discoveredFromBookingId ? [discoveredFromBookingId] : []),
              isFutureBooking: true,
              sourceBookingId: discoveredFromBookingId || null,
              sourceBookingDate: discoveredFromDate || null
            };

            futureBookingsCreated.push({
              centerId: futureCenterId,
              services: futureServices,
              date: futureDate,
              bookingId: bookingData.id,
              source_booking_id: discoveredFromBookingId || null,
              source_booking_date: discoveredFromDate || null
            });

            registerFutureAvailability(futureCenterId, futureDate);
            recordFutureBookingMap(futureCenterId, futureDate, bookingData.id);

            return result;
          } catch (err) {
            console.log(`Failed to create/fetch future booking for center ${futureCenterId}, date ${futureDate}: ${err.message}`);
            futureBookingFailures.push({
              centerId: futureCenterId,
              date: futureDate,
              services: futureServices,
              discoveredFromBookingId,
              discoveredFromDate,
              error: err.message
            });
            pendingFutureBookingKeys.delete(futureKey);
            return null;
          } finally {
            pendingFutureBookingKeys.delete(futureKey);
          }
        }));

        futureResults
          .filter(Boolean)
          .forEach(result => {
            resultQueue.push(result);
          });
      }
    }

    const slotsByDate = {};
    const dateAvailability = {};
    const weeklyAvailabilityMap = new Map();
    
    allSlotsResults.forEach(result => {
      const {
        centerId,
        services,
        date,
        bookingId,
        slots,
        futureDays,
        nextAvailableDay,
        error,
        discoveredFromDates,
        discoveredFromBookingIds,
        isFutureBooking,
        sourceBookingId,
        sourceBookingDate
      } = result;

      const availableSlotsCount = Array.isArray(slots)
        ? slots.filter(slot => slot.Available).length
        : 0;

      const hourlyBuckets = aggregateSlotsIntoHourlyBuckets(slots || []);

      if (!slotsByDate[date]) {
        slotsByDate[date] = {};
      }

      slotsByDate[date][centerId] = {
        services,
        slots,
        hourly_buckets: hourlyBuckets,
        available_slots_count: availableSlotsCount,
        has_slots: availableSlotsCount > 0,
        booking_id: bookingId,
        is_future_booking: !!isFutureBooking,
        discovered_from_dates: discoveredFromDates,
        discovered_from_booking_ids: discoveredFromBookingIds,
        source_booking_id: sourceBookingId,
        source_booking_date: sourceBookingDate,
        next_available_day: nextAvailableDay || null,
        error
      };

      if (bookingId) {
        slotsByBookingId.set(bookingId, {
          centerId,
          services,
          date,
          slots,
          hourly_buckets: hourlyBuckets,
          available_slots_count: availableSlotsCount,
          has_slots: availableSlotsCount > 0,
          is_future_booking: !!isFutureBooking,
          discovered_from_dates: discoveredFromDates,
          discovered_from_booking_ids: discoveredFromBookingIds,
          source_booking_id: sourceBookingId,
          source_booking_date: sourceBookingDate,
          next_available_day: nextAvailableDay || null,
          error
        });
      }

      const futureAvailableDates = Array.isArray(futureDays)
        ? futureDays
            .filter(day => (day?.IsAvailable ?? day?.isAvailable) === true)
            .map(day => {
              const rawDay = day?.Day || day?.day || day?.date;
              if (!rawDay) {
                return null;
              }
              return rawDay.split('T')[0];
            })
            .filter(Boolean)
        : [];

      futureAvailableDates.forEach(futureDate => {
        registerFutureAvailability(centerId, futureDate);
      });
    });

    const sortedRelevantDates = Object.keys(slotsByDate).sort((a, b) => a.localeCompare(b));

    sortedRelevantDates.forEach(date => {
      const centerEntries = Object.entries(slotsByDate[date] || {});

      const totalAvailableSlots = centerEntries.reduce((total, [, centerData]) => {
        return total + (centerData.available_slots_count || 0);
      }, 0);

      const centersWithAvailabilityDetails = centerEntries
        .filter(([, centerData]) => centerData.has_slots)
        .map(([centerId, centerData]) => {
          const provider = getProviderById(centerId);
          const hourlySlots = Array.isArray(centerData.hourly_buckets)
            ? centerData.hourly_buckets
                .filter(bucket => bucket?.time && bucket.available !== false && (bucket.count ?? 0) > 0)
                .map(bucket => ({
                  time: bucket.time,
                  available: bucket.available !== false,
                  count: bucket.count ?? 0
                }))
            : [];

          const slotTimes = Array.isArray(centerData.slots)
            ? centerData.slots
                .filter(slot => slot?.Available)
                .map(slot => ({ time: slot.Time || slot.time || slot.start_time || null }))
                .filter(slot => !!slot.time)
            : [];

          return {
            id: centerId,
            no_of_slots: centerData.available_slots_count || 0,
            hourly_slots: hourlySlots,
            slots: slotTimes,
            booking_id: centerData.booking_id || centerData.source_booking_id || null,
            priority: provider?.priority ?? null
          };
        })
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

      const centersWithAvailability = centersWithAvailabilityDetails.length;
      const hasSlots = centersWithAvailability > 0;

      dateAvailability[date] = {
        hasSlots,
        centersWithAvailability,
        totalAvailableSlots,
        center_ids: centersWithAvailabilityDetails
      };

      if (hasSlots) {
        const weekStart = getWeekStartDate(date);
        if (!weeklyAvailabilityMap.has(weekStart)) {
          weeklyAvailabilityMap.set(weekStart, new Set());
        }
        weeklyAvailabilityMap.get(weekStart).add(date);
      }
    });
    
    const weeklyAvailability = Array.from(weeklyAvailabilityMap.entries()).map(([weekStart, datesSet]) => {
      const sortedDates = Array.from(datesSet).sort((a, b) => a.localeCompare(b));
      const matchedWeek = weekInfo?.find(week => getWeekStartDate(week.date) === weekStart);
      return {
        week_start: weekStart,
        week_label: matchedWeek?.weekName || `Week starting ${weekStart}`,
        available_dates: sortedDates
      };
    }).sort((a, b) => a.week_start.localeCompare(b.week_start));

    const availableDates = sortedRelevantDates.filter(date => dateAvailability[date]?.hasSlots);

    const futureDayAvailability = Array.from(futureDayAvailabilityMap.entries()).map(([centerId, datesSet]) => ({
      centerId,
      available_dates: Array.from(datesSet).sort((a, b) => a.localeCompare(b))
    }));

    const futureDayBookings = Array.from(futureDayBookingMap.entries()).map(([centerId, bookingsMap]) => ({
      centerId,
      bookings: Array.from(bookingsMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, bookingId]) => ({ date, bookingId }))
    }));

    const detailedSlotsByBooking = Object.fromEntries(Array.from(slotsByBookingId.entries()));

    const processingTime = Date.now() - startTime;
    const totalFutureBookingsCreated = futureBookingsCreated.length;

    const bookingMappingList = [];
    const bookingMappingSeen = new Set();

    const pushBookingMapping = ({ centerId, services, date, bookingId, isFutureBooking = false, sourceBookingId = null, sourceBookingDate = null }) => {
      if (!bookingId || bookingMappingSeen.has(bookingId)) {
        return;
      }
      bookingMappingSeen.add(bookingId);
      bookingMappingList.push({
        centerId,
        services,
        date,
        bookingId,
        is_future_booking: isFutureBooking,
        source_booking_id: sourceBookingId,
        source_booking_date: sourceBookingDate
      });
    };

    successfulBookings.forEach(booking => {
      pushBookingMapping({
        centerId: booking.centerId,
        services: booking.services,
        date: booking.date,
        bookingId: booking.bookingId,
        isFutureBooking: false
      });
    });

    futureBookingsCreated.forEach(booking => {
      pushBookingMapping({
        centerId: booking.centerId,
        services: booking.services,
        date: booking.date,
        bookingId: booking.bookingId,
        isFutureBooking: true,
        sourceBookingId: booking.source_booking_id,
        sourceBookingDate: booking.source_booking_date
      });
    });
    
    res.json({
      success: true,
      data: {
        date_availability: dateAvailability,
        available_dates: availableDates,
        centers: centers,
        services: services,
        processing_time_ms: processingTime
      },
      message: `Retrieved availability for ${successfulBookings.length} center/date booking combinations in ${processingTime}ms.`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Categories endpoint (Real Zenoti Data)

// Unified categories endpoint with services (requires centerIds parameter)
app.get('/api/categories', async (req, res) => {
  try {
    // Get center IDs from query params
    const { centerIds } = req.query;
    if (!centerIds) {
      res.status(400).json({
        success: false,
        error: 'centerIds query parameter is required'
      });
      return;
    }
    
    const centers = centerIds.split(',');
    
    const aggregatedData = await aggregateCategoriesWithServicesFromAllCenters(centers);
    const categories = aggregatedData.categories;
    
    // Create response structure with services grouped under categories
    const categoriesResponse = categories.map(category => ({
      category_id: category.id,
      category_name: category.name,
      display_order: category.display_order,
      code: category.code,
      description: category.description,
      html_description: category.html_description,
      show_in_catalog: category.show_in_catalog,
      available_centers: category.available_centers,
      services: category.services || []
    }));
    
    // Calculate total services across all categories
    const totalServices = categoriesResponse.reduce((total, category) => {
      return total + (category.services ? category.services.length : 0);
    }, 0);
    
    res.json({
      success: true,
      data: {
        categories: categoriesResponse,
        total_categories: categoriesResponse.length,
        total_services: totalServices,
        centers: centers
      },
      message: `Found ${categoriesResponse.length} categories with ${totalServices} services across ${centers.length} centers`
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Statistics endpoint

// Booking Management endpoints (Reserve, Confirm, Status, Cancel)

// Create or update guest in Zenoti
app.post('/api/guests', async (req, res) => {
  try {
    const { name, first_name: firstName, last_name: lastName, email, phone, provider_id: providerId } = req.body;

    const result = await createGuestInZenoti({
      centerId: providerId,
      name,
      firstName,
      lastName,
      email,
      phone
    });

    console.log('[POST /api/guests] Guest created successfully', {
      center_id: providerId,
      email,
      phone: result.sanitizedPhone
    });

    res.json({
      success: true,
      data: result.data,
      message: 'Guest created successfully'
    });
  } catch (error) {
    console.error('Error creating guest:', error.message);
    if (error.response) {
      console.error('Zenoti API response status:', error.response.status);
      console.error('Zenoti API response data:', error.response.data);
    }

    const statusCode = error instanceof ApiValidationError ? error.statusCode : (error.response?.status || 500);

    res.status(statusCode).json({
      success: false,
      error: error.message,
      details: error.response?.data || error.details || null
    });
  }
});

app.post('/api/bookings/:bookingId/reserve', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    // Debug logging
    console.log('[DEBUG] Request headers:', req.headers);
    console.log('[DEBUG] Request body:', req.body);
    console.log('[DEBUG] Request query:', req.query);
    console.log('[DEBUG] Request body type:', typeof req.body);
    
    // Accept slot_time from either query params or body
    const slotTime = req.query.slot_time || req.body?.slot_time;
    const createInvoice = req.query.create_invoice === 'true' || req.body?.create_invoice || false;

    const result = await reserveSlotInZenoti({
      bookingId,
      slotTime,
      createInvoice
    });

    // Extract reservation_id from Zenoti response (it returns an array)
    const reservationId = Array.isArray(result.data) && result.data.length > 0
      ? result.data[0].reservation_id
      : null;

    console.log('[POST /api/bookings/:bookingId/reserve] Slot reserved', {
      booking_id: bookingId,
      reservation_id: reservationId,
      slot_time: result.formattedSlotTime,
      createInvoice
    });

    res.json({
      success: true,
      data: result.data,
      message: `Slot reserved successfully for booking ${bookingId}`,
      booking_id: bookingId,
      reservation_id: reservationId,
      slot_time: result.formattedSlotTime
    });
  } catch (error) {
    console.error(`Error reserving slot for booking ${req.params.bookingId}:`, error.message);
    if (error.response) {
      console.error('Zenoti API response status:', error.response.status);
      console.error('Zenoti API response data:', error.response.data);
    }

    const statusCode = error instanceof ApiValidationError ? error.statusCode : (error.response?.status || 500);

    res.status(statusCode).json({
      success: false,
      error: error.message,
      booking_id: req.params.bookingId,
      details: error.response?.data || error.details || null
    });
  }
});

// Confirm a service booking
app.post('/api/bookings/:bookingId/confirm', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { guest, payment_method, notes } = req.body;
    
    if (!guest) {
      res.status(400).json({
        success: false,
        error: 'guest information is required'
      });
      return;
    }
    
    const zenotiApiKey = process.env.ZENOTI_API_KEY;
    const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';
    
    if (!zenotiApiKey) {
      throw new Error('Zenoti API key not configured');
    }
    
    const confirmPayload = {
      guest: {
        id: guest.id || null,
        first_name: guest.first_name || guest.firstName,
        last_name: guest.last_name || guest.lastName,
        email: guest.email,
        phone: guest.phone,
        date_of_birth: guest.date_of_birth || guest.dateOfBirth,
        gender: guest.gender,
        address: guest.address ? {
          street: guest.address.street,
          city: guest.address.city,
          state: guest.address.state,
          zip_code: guest.address.zip_code || guest.address.zipCode,
          country: guest.address.country || 'US'
        } : undefined
      },
      payment_method: payment_method || 'credit_card',
      notes: notes || ''
    };
    
    console.log(`Confirming booking ${bookingId} for guest:`, confirmPayload.guest.first_name, confirmPayload.guest.last_name);
    
    const response = await makeZenotiRequest(async () => {
      return await axios.post(`${zenotiBaseUrl}/bookings/${bookingId}/slots/confirm`, confirmPayload, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });
    
    // Extract relevant data from Zenoti response
    const isConfirmed = response.data.is_confirmed || false;
    const invoice = response.data.invoice || {};
    const invoiceId = invoice.invoice_id || null;
    const guestInfo = invoice.guest || null;
    
    // Extract appointment_id from first item if available
    const items = invoice.items || [];
    const appointmentId = items.length > 0 ? items[0].appointment_id : null;
    
    res.json({
      success: true,
      data: response.data,
      message: `Booking ${bookingId} confirmed successfully`,
      booking_id: bookingId,
      is_confirmed: isConfirmed,
      invoice_id: invoiceId,
      appointment_id: appointmentId,
      guest: guestInfo,
      items: items
    });
    
  } catch (error) {
    console.error(`Error confirming booking ${req.params.bookingId}:`, error.message);
    if (error.response) {
      console.error('Zenoti API response status:', error.response.status);
      console.error('Zenoti API response data:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      booking_id: req.params.bookingId
    });
  }
});

// Get booking status
app.get('/api/bookings/:bookingId/status', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const zenotiApiKey = process.env.ZENOTI_API_KEY;
    const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';
    
    if (!zenotiApiKey) {
      throw new Error('Zenoti API key not configured');
    }
    
    const response = await makeZenotiRequest(async () => {
      return await axios.get(`${zenotiBaseUrl}/bookings/${bookingId}`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });
    
    res.json({
      success: true,
      data: response.data,
      message: `Booking status retrieved for ${bookingId}`,
      booking_id: bookingId
    });
    
  } catch (error) {
    console.error(`Error getting booking status for ${req.params.bookingId}:`, error.message);
    if (error.response) {
      console.error('Zenoti API response status:', error.response.status);
      console.error('Zenoti API response data:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      booking_id: req.params.bookingId
    });
  }
});

// Cancel reservation
app.delete('/api/bookings/:bookingId/reserve', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const zenotiApiKey = process.env.ZENOTI_API_KEY;
    const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';
    
    if (!zenotiApiKey) {
      throw new Error('Zenoti API key not configured');
    }
    
    const response = await makeZenotiRequest(async () => {
      return await axios.delete(`${zenotiBaseUrl}/bookings/${bookingId}/slots/reserve`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });
    
    res.json({
      success: true,
      data: response.data,
      message: `Reservation cancelled for booking ${bookingId}`,
      booking_id: bookingId
    });
    
  } catch (error) {
    console.error(`Error cancelling reservation for booking ${req.params.bookingId}:`, error.message);
    if (error.response) {
      console.error('Zenoti API response status:', error.response.status);
      console.error('Zenoti API response data:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      booking_id: req.params.bookingId
    });
  }
});

// Select provider and create booking
app.post('/api/slots/select-provider', async (req, res) => {
  try {
    const { center_id, guest_id, service_ids, date } = req.body;
    
    // Debug logging
    console.log('🎯 Provider selection request received:', {
      center_id,
      guest_id,
      service_ids,
      date,
      timestamp: new Date().toISOString()
    });
    
    if (!center_id) {
      res.status(400).json({
        success: false,
        error: 'center_id is required',
        received: { center_id }
      });
      return;
    }
    
    if (!guest_id) {
      res.status(400).json({
        success: false,
        error: 'guest_id is required',
        received: { guest_id }
      });
      return;
    }
    
    if (!Array.isArray(service_ids) || service_ids.length === 0) {
      res.status(400).json({
        success: false,
        error: 'service_ids must be a non-empty array',
        received: { service_ids }
      });
      return;
    }
    
    if (!date) {
      res.status(400).json({
        success: false,
        error: 'date is required',
        received: { date }
      });
      return;
    }
    
    // Create a fresh booking for the provided slot and date
    const zenotiApiKey = process.env.ZENOTI_API_KEY;
    const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';
    
    if (!zenotiApiKey) {
      throw new Error('Zenoti API key not configured');
    }
    
    // Get full provider details from static data
    const provider = getProviderById(center_id);
    
    if (!provider) {
      res.status(404).json({
        success: false,
        error: `Provider not found for center ID: ${center_id}`,
        center_id
      });
      return;
    }
    
    console.log('✅ Selected provider:', {
      center_id,
      name: provider.name
    });
    
    // Format date to YYYY-MM-DD
    const formattedDate = new Date(date).toISOString().split('T')[0];
    
    // Generate a NEW booking through Zenoti
    let bookingId;
    try {
      const bookingPayload = {
        center_id: center_id,
        date: formattedDate,
        guests: [
          {
            id: guest_id,
            items: service_ids.map(serviceId => ({
              item: { id: serviceId }
            }))
          }
        ]
      };
      
      console.log('🎯 Creating booking with payload:', JSON.stringify(bookingPayload, null, 2));
      
      const bookingResponse = await makeZenotiRequest(async () => {
        return await axios.post(`${zenotiBaseUrl}/bookings?is_double_booking_enabled=false`, bookingPayload, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `apikey ${zenotiApiKey}`
          }
        });
      });
      
      bookingId = bookingResponse.data?.id;
      
      console.log('✅ Booking created successfully:', {
        bookingId,
        center_id,
        date: formattedDate
      });
    } catch (error) {
      console.error(`❌ Failed to create booking for center ${center_id}:`, error.message);
      if (error.response) {
        console.error('Zenoti API response status:', error.response.status);
        console.error('Zenoti API response data:', error.response.data);
      }
      res.status(500).json({
        success: false,
        error: 'Failed to generate booking ID',
        details: error.response?.data || error.message,
        center_id,
        date: formattedDate
      });
      return;
    }
    
    if (!bookingId) {
      res.status(500).json({
        success: false,
        error: 'Booking ID not returned from Zenoti',
        center_id,
        date: formattedDate
      });
      return;
    }
    
    // Log the selection and booking creation for analytics
    console.log(`🎯 Provider selected and booking created:`, {
      provider: provider.name,
      bookingId,
      guest_id,
      center_id,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      data: {
        center_id,
        center_name: provider.name,
        booking_id: bookingId,
        guest_id,
        date: formattedDate
      },
      message: `Provider ${provider.name} selected with booking ID: ${bookingId}`
    });
    
  } catch (error) {
    console.error(`Error selecting provider:`, error.message);
    
    res.status(500).json({
      success: false,
      error: error.message,
      center_id: req.body.center_id,
      guest_id: req.body.guest_id,
      date: req.body.date
    });
  }
});





// Rate limit status endpoint
app.get('/api/rate-limit/status', (req, res) => {
  const now = Date.now();
  res.json({
    success: true,
    data: {
      cache_size: cache.size
    },
    message: 'Rate limit status retrieved successfully'
  });
});

// Clear cache endpoint
app.post('/api/cache/clear', (req, res) => {
  try {
    const cacheSize = cache.size;
    cache.clear();
    
    // Reset rate limiting
    res.json({
      success: true,
      message: `Cache cleared successfully. Removed ${cacheSize} entries.`,
      cache_size_before: cacheSize,
      cache_size_after: 0,
      rate_limit_reset: true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    path: req.originalUrl,
    availableEndpoints: [
      'GET /api/providers',
      'GET /api/providers/zipcode/:zipcode',
      'GET /api/providers/:providerId',
      'GET /api/address/suggestions?input=address',
      'POST /api/address/validate',
      'POST /api/address/centers',
      'GET /api/services/category/:categoryId',
      'GET /api/categories',
      'POST /api/bookings (single or multiple centers)',
      'GET /api/bookings/:bookingId/slots?check_future_day_availability=true',
      'POST /api/slots/unified',
      'POST /api/slots/select-provider (first available)',
      'POST /api/guests',
      'GET /api/slots/test-provider-selection',
      'GET /api/slots/test-week-dates',
      'POST /api/bookings/:bookingId/reserve',
      'POST /api/bookings/:bookingId/confirm',
      'GET /api/bookings/:bookingId/status',
      'DELETE /api/bookings/:bookingId/reserve',
      'GET /api/rate-limit/status',
      'POST /api/cache/clear'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`📋 Available endpoints:`);
  console.log(`   - GET /api/providers`);
  console.log(`   - GET /api/providers/zipcode/:zipcode`);
  console.log(`   - GET /api/providers/:providerId`);
  console.log(`   - GET /api/address/suggestions?input=address`);
  console.log(`   - POST /api/address/validate`);
  console.log(`   - POST /api/address/centers`);
  console.log(`   - GET /api/categories (with services)`);
  console.log(`   - POST /api/bookings (single or multiple centers)`);
  console.log(`   - GET /api/bookings/:bookingId/slots (with future day availability)`);
  console.log(`   - POST /api/slots/unified (with hourly aggregation and week-based selection)`);
  console.log(`   - POST /api/slots/select-provider`);
  console.log(`   - POST /api/guests`);
  console.log(`   - POST /api/bookings/:bookingId/reserve`);
  console.log(`   - POST /api/bookings/:bookingId/confirm`);
  console.log(`   - GET /api/bookings/:bookingId/status`);
  console.log(`   - DELETE /api/bookings/:bookingId/reserve`);
  console.log(`   - GET /api/rate-limit/status`);
});

export default app;
