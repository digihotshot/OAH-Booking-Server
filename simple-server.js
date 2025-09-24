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

// Helper functions
const getProvidersByZipcode = (zipcode) => {
  return providers.filter(provider => 
    provider.status === 'active' && 
    provider.zipCodes.includes(zipcode)
  ).sort((a, b) => a.priority - b.priority);
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

// Rate limiting and retry logic
const rateLimitTracker = {
  calls: 0,
  windowStart: Date.now(),
  maxCallsPerMinute: 50, // Conservative limit (Zenoti allows 60)
  retryDelays: [1000, 2000, 5000, 10000], // Progressive backoff
  maxRetries: 4
};

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
const checkRateLimit = () => {
  const now = Date.now();
  const timeSinceWindowStart = now - rateLimitTracker.windowStart;
  
  // Reset window if more than 60 seconds have passed
  if (timeSinceWindowStart >= 60000) {
    rateLimitTracker.calls = 0;
    rateLimitTracker.windowStart = now;
  }
  
  // Check if we're approaching the limit
  if (rateLimitTracker.calls >= rateLimitTracker.maxCallsPerMinute) {
    const waitTime = 60000 - timeSinceWindowStart;
    console.log(`Rate limit reached. Waiting ${waitTime}ms before next request...`);
    return waitTime;
  }
  
  rateLimitTracker.calls++;
  return 0;
};

// Retry logic with exponential backoff
const makeZenotiRequest = async (requestFn, retryCount = 0) => {
  try {
    // Check rate limit before making request
    const waitTime = checkRateLimit();
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    const response = await requestFn();
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
        
        await new Promise(resolve => setTimeout(resolve, actualDelay));
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
const fetchZenotiSlots = async (bookingId) => {
  const zenotiApiKey = process.env.ZENOTI_API_KEY;
  const zenotiBaseUrl = process.env.ZENOTI_BASE_URL || 'https://api.zenoti.com/v1';
  
  if (!zenotiApiKey) {
    throw new Error('Zenoti API key not configured');
  }

  const cacheKey = `slots-${bookingId}`;
  const cachedData = getCachedData(cacheKey);
  if (cachedData) {
    console.log(`Cache hit for slots: ${bookingId}`);
    return cachedData;
  }

  try {
    const response = await makeZenotiRequest(async () => {
      return await axios.get(`${zenotiBaseUrl}/bookings/${bookingId}/slots`, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `apikey ${zenotiApiKey}`
        }
      });
    });
    
    setCachedData(cacheKey, response.data, 300000); // 5 minutes cache
    console.log(`Cached slots data for booking: ${bookingId}`);
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
    
    // Extract time from slot (assuming format like "09:00:00" or "09:00")
    const timeStr = slot.Time || slot.time || slot.start_time || '';
    if (!timeStr) return;
    
    // Parse time and round down to nearest hour
    const [hours] = timeStr.split(':').map(Number);
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

// Create booking endpoint (supports single or multiple services)
app.post('/api/bookings', async (req, res) => {
  try {
    const { centerId, date, serviceId, serviceIds } = req.body;
    
    if (!centerId || !date) {
      res.status(400).json({
        success: false,
        error: 'centerId and date are required'
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
    
    const bookingData = await createZenotiBooking(centerId, date, services);
    
    res.json({
      success: true,
      data: bookingData,
      message: `Booking created for ${services.length} service(s) on ${date}`,
      services: services
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get slots for a specific booking
app.get('/api/bookings/:bookingId/slots', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const slotsData = await fetchZenotiSlots(bookingId);
    
    res.json({
      success: true,
      data: slotsData,
      message: `Retrieved slots for booking ${bookingId}`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Unified slots endpoint for multiple centers and services
app.post('/api/slots/unified', async (req, res) => {
  try {
    const { centers, services, date, dates } = req.body;
    
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
    
    // Handle both single date and dates array, with 28-day limit
    let targetDates = [];
    if (dates && Array.isArray(dates) && dates.length > 0) {
      targetDates = dates;
    } else if (date) {
      targetDates = [date];
    } else {
      res.status(400).json({
        success: false,
        error: 'Either date or dates array is required'
      });
      return;
    }
    
    // Limit to 28 days (4 weeks) from current date
    const today = new Date();
    const maxDate = new Date(today.getTime() + (28 * 24 * 60 * 60 * 1000)); // 28 days from today
    
    // Filter dates to only include those within 28 days
    targetDates = targetDates.filter(dateStr => {
      const date = new Date(dateStr);
      return date >= today && date <= maxDate;
    });
    
    if (targetDates.length === 0) {
      res.status(400).json({
        success: false,
        error: 'No valid dates within 28-day range from today'
      });
      return;
    }

    // Create all booking combinations in parallel for all dates
    const bookingPromises = [];
    const bookingMap = new Map(); // To track which booking belongs to which center/service/date
    
    centers.forEach(centerId => {
      targetDates.forEach(date => {
        // Create a single booking with all services for this center and date
        const promise = createZenotiBooking(centerId, date, services)
          .then(bookingData => {
            if (bookingData.id && !bookingData.error) {
              bookingMap.set(bookingData.id, { centerId, services, date, bookingData });
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
          slots: [],
          centers: centers,
          services: services,
          dates: targetDates,
          total_combinations: bookingResults.length,
          successful_combinations: 0
        },
        message: 'No successful bookings created'
      });
      return;
    }

    // Fetch slots for all successful bookings in parallel
    const slotsPromises = successfulBookings.map(async ({ bookingId, centerId, services, date }) => {
      try {
        const slotsData = await fetchZenotiSlots(bookingId);
        return {
          centerId,
          services,
          date,
          bookingId,
          slots: slotsData.slots || [],
          error: slotsData.Error
        };
  } catch (error) {
        console.log(`Failed to fetch slots for booking ${bookingId}: ${error.message}`);
        return {
          centerId,
          services,
          date,
          bookingId,
          slots: [],
      error: error.message
        };
      }
    });

    const slotsResults = await Promise.all(slotsPromises);
    
    // Aggregate slots by date and center with hourly buckets
    const slotsByDate = {};
    
    slotsResults.forEach(result => {
      const { centerId, services, date, slots, error } = result;
      
      if (!slotsByDate[date]) {
        slotsByDate[date] = {};
      }
      
      if (!slotsByDate[date][centerId]) {
        // Aggregate 15-minute slots into 1-hour buckets (primary response)
        const availableSlots = slots.filter(slot => slot.Available);
        const hourlyBuckets = aggregateSlotsIntoHourlyBuckets(availableSlots);
        
        slotsByDate[date][centerId] = {
          hourly_slots: hourlyBuckets, // Primary: 1-hour aggregated slots only
          services: services,
          error: error
        };
      }
    });
    
    // Create flatter structure for frontend with hourly aggregation
    const dateAvailability = {};
    const allSlotsByDate = {};
    
    targetDates.forEach(date => {
      const dateData = slotsByDate[date] || {};
      let hasSlots = false;
      let hourlySlotsCount = 0;
      let allHourlySlots = [];
      let centersWithSlots = [];
      
      // Process all centers for this date
      Object.entries(dateData).forEach(([centerId, centerData]) => {
        if (centerData.hourly_slots && centerData.hourly_slots.length > 0) {
          hasSlots = true;
          hourlySlotsCount += centerData.hourly_slots.length;
          allHourlySlots = allHourlySlots.concat(centerData.hourly_slots);
          
          centersWithSlots.push({
            centerId,
            hourly_slots: centerData.hourly_slots,
            services: centerData.services
          });
        }
      });
      
      // Deduplicate and merge hourly slots across centers
      const mergedHourlySlots = mergeHourlySlotsAcrossCenters(allHourlySlots);
      
      dateAvailability[date] = {
        hasSlots,
        hourlySlotsCount: mergedHourlySlots.length,
        centersCount: centersWithSlots.length
      };
      
      allSlotsByDate[date] = {
        hasSlots,
        hourlySlotsCount: mergedHourlySlots.length,
        hourly_slots: mergedHourlySlots, // Primary: 1-hour aggregated slots only
        centers: centersWithSlots
      };
    });
    
    res.json({
      success: true,
      data: {
        // New flatter structure for frontend with hourly aggregation
        date_availability: dateAvailability,
        slots_by_date: allSlotsByDate,
        // Keep original structure for backward compatibility
        slots_by_center: slotsByDate,
        centers: centers,
        services: services,
        dates: targetDates,
        total_combinations: bookingResults.length,
        successful_combinations: successfulBookings.length,
        failed_combinations: bookingResults.length - successfulBookings.length,
        // Performance metrics
        aggregation_info: {
          original_slots: slotsResults.reduce((total, result) => total + (result.slots?.length || 0), 0),
          hourly_slots: Object.values(allSlotsByDate).reduce((total, dateData) => total + (dateData.hourly_slots?.length || 0), 0),
          reduction_percentage: Math.round((1 - Object.values(allSlotsByDate).reduce((total, dateData) => total + (dateData.hourly_slots?.length || 0), 0) / Math.max(1, slotsResults.reduce((total, result) => total + (result.slots?.length || 0), 0))) * 100),
          optimization_note: "Response contains only hourly_slots for optimal performance"
        }
      },
      message: `Retrieved slots for ${successfulBookings.length} successful booking combinations across ${targetDates.length} dates (28-day limit). Aggregated ${slotsResults.reduce((total, result) => total + (result.slots?.length || 0), 0)} 15-min slots into ${Object.values(allSlotsByDate).reduce((total, dateData) => total + (dateData.hourly_slots?.length || 0), 0)} hourly slots.`
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

// Rate limit status endpoint
app.get('/api/rate-limit/status', (req, res) => {
  const now = Date.now();
  const timeSinceWindowStart = now - rateLimitTracker.windowStart;
  const remainingTime = Math.max(0, 60000 - timeSinceWindowStart);
    
    res.json({
      success: true,
      data: {
      calls_made: rateLimitTracker.calls,
      max_calls_per_minute: rateLimitTracker.maxCallsPerMinute,
      remaining_calls: Math.max(0, rateLimitTracker.maxCallsPerMinute - rateLimitTracker.calls),
      window_reset_in_ms: remainingTime,
      window_reset_in_seconds: Math.ceil(remainingTime / 1000),
      cache_size: cache.size
    },
    message: 'Rate limit status retrieved successfully'
  });
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
      'POST /api/bookings',
      'GET /api/bookings/:bookingId/slots',
      'POST /api/slots/unified',
      'GET /api/rate-limit/status'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Zenoti API Layer running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⚡ Rate Limiting: ${rateLimitTracker.maxCallsPerMinute} calls/minute with retry logic`);
  console.log(`💾 Caching: ${CACHE_TTL/1000}s TTL enabled`);
  console.log(`🕐 Slot Aggregation: 15-min slots → 1-hour buckets (75% reduction, optimized response)`);
  console.log(`📅 Date Range: Limited to 28 days (4 weeks) from current date`);
  console.log(`📋 Available endpoints:`);
  console.log(`   - GET /api/providers`);
  console.log(`   - GET /api/providers/zipcode/:zipcode`);
  console.log(`   - GET /api/providers/:providerId`);
  console.log(`   - GET /api/address/suggestions?input=address`);
  console.log(`   - POST /api/address/validate`);
  console.log(`   - POST /api/address/centers`);
  console.log(`   - GET /api/categories (with services)`);
  console.log(`   - POST /api/bookings`);
  console.log(`   - GET /api/bookings/:bookingId/slots`);
  console.log(`   - POST /api/slots/unified (with hourly aggregation)`);
  console.log(`   - GET /api/rate-limit/status`);
  console.log(`\n🎯 Test with: curl http://localhost:${PORT}/api/providers/zipcode/48236`);
  console.log(`📊 Rate limit status: curl http://localhost:${PORT}/api/rate-limit/status`);
  console.log(`🕐 Hourly slots: Frontend uses 'hourly_slots' array only (optimized for performance)`);
});

export default app;
