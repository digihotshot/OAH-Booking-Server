# Zenoti API Layer

A lightweight API middleware layer for the Zenoti booking system that provides provider lookup, zipcode-based center search, and priority-based allocation.

## Features

### Provider Management
- Provider lookup by zipcode with priority ordering
- Real-time provider data with 274+ zipcodes covered
- Priority-based center allocation (1-16 scale)

### Address & Center Search
- Zipcode-based provider discovery
- Address validation and center matching
- Priority ordering for optimal provider selection

## API Endpoints

### Provider Management
- `GET /api/providers` - Get all providers with zipcode and priority data
- `GET /api/providers/zipcode/:zipcode` - Get providers serving a specific zipcode
- `GET /api/providers/:providerId` - Get specific provider details

### Address & Center Lookup
- `GET /api/address/suggestions?input=address` - Get address suggestions from Google Places
- `POST /api/address/validate` - Validate address and get full details with zipcode
- `POST /api/address/centers` - Find centers by address/zipcode

### Services Management
- `GET /api/services?page=1&limit=10` - Get all services with pagination
- `POST /api/services/common` - Get common services across multiple centers (with pagination)
- `POST /api/services/calculate-price` - Calculate total price for selected services
- `GET /api/services/categories` - Get all service categories
- `GET /api/services/category/:category?page=1&limit=10` - Get services by specific category (with pagination)

### System
- `GET /api/health` - Health check and system status
- `GET /api/stats` - Provider statistics and coverage data

## Pagination Support

All services endpoints support pagination to handle large datasets:

### Query Parameters
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10)

### Pagination Response
```json
{
  "success": true,
  "data": {
    "services": [...],
    "pagination": {
      "currentPage": 1,
      "totalPages": 3,
      "totalItems": 8,
      "itemsPerPage": 10,
      "hasNextPage": true,
      "hasPrevPage": false
    }
  }
}
```

### Examples
```bash
# Get first page with 10 items
GET /api/services?page=1&limit=10

# Get second page with 5 items
GET /api/services?page=2&limit=5

# Get services by category with pagination
GET /api/services/category/Skincare?page=1&limit=3

# Get common services with pagination
POST /api/services/common
{
  "centerIds": ["center1", "center2"],
  "page": 1,
  "limit": 5
}
```

## Frontend Integration Guide

### Google Places Address Autocomplete Flow

Here's how to implement the complete address selection flow in your frontend:

#### Step 1: Address Suggestions (As User Types)

```javascript
// Get address suggestions as user types
const getAddressSuggestions = async (input) => {
  if (input.length < 3) return [];
  
  try {
    const response = await fetch(
      `http://localhost:3000/api/address/suggestions?input=${encodeURIComponent(input)}`
    );
    const data = await response.json();
    return data.success ? data.data : [];
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    return [];
  }
};
```

#### Step 2: Address Validation (When User Selects)

```javascript
// Validate selected address and get full details
const validateAddress = async (placeId) => {
  try {
    const response = await fetch('http://localhost:3000/api/address/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeId })
    });
    const data = await response.json();
    return data.success ? data.data : null;
  } catch (error) {
    console.error('Error validating address:', error);
    return null;
  }
};
```

#### Step 3: Find Centers by Address

```javascript
// Find centers serving the validated address
const findCentersByAddress = async (address) => {
  try {
    const response = await fetch('http://localhost:3000/api/address/centers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address })
    });
    const data = await response.json();
    return data.success ? data.data : [];
  } catch (error) {
    console.error('Error finding centers:', error);
    return [];
  }
};
```

### Complete React Example

```jsx
import React, { useState, useEffect, useCallback } from 'react';

const AddressAutocomplete = () => {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [selectedAddress, setSelectedAddress] = useState(null);
  const [centers, setCenters] = useState([]);
  const [loading, setLoading] = useState(false);

  // Debounced search for suggestions
  const debouncedSearch = useCallback(
    debounce(async (searchInput) => {
      if (searchInput.length >= 3) {
        const results = await getAddressSuggestions(searchInput);
        setSuggestions(results);
      } else {
        setSuggestions([]);
      }
    }, 300),
    []
  );

  useEffect(() => {
    debouncedSearch(input);
  }, [input, debouncedSearch]);

  const handleSuggestionClick = async (suggestion) => {
    setLoading(true);
    setInput(suggestion.description);
    setSuggestions([]);
    
    // Validate the selected address
    const addressDetails = await validateAddress(suggestion.placeId);
    if (addressDetails) {
      setSelectedAddress(addressDetails);
      
      // Find centers for this address
      const centersData = await findCentersByAddress(addressDetails);
      setCenters(centersData);
    }
    setLoading(false);
  };

  return (
    <div className="address-autocomplete">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Enter your address..."
        className="address-input"
      />
      
      {suggestions.length > 0 && (
        <ul className="suggestions-list">
          {suggestions.map((suggestion) => (
            <li
              key={suggestion.placeId}
              onClick={() => handleSuggestionClick(suggestion)}
              className="suggestion-item"
            >
              <strong>{suggestion.mainText}</strong>
              <span>{suggestion.secondaryText}</span>
            </li>
          ))}
        </ul>
      )}
      
      {selectedAddress && (
        <div className="selected-address">
          <h3>Selected Address:</h3>
          <p>{selectedAddress.formattedAddress}</p>
          <p>Zipcode: {selectedAddress.zipcode}</p>
          <p>City: {selectedAddress.city}, {selectedAddress.state}</p>
        </div>
      )}
      
      {centers.length > 0 && (
        <div className="available-centers">
          <h3>Available Centers ({centers.length}):</h3>
          {centers.map((center) => (
            <div key={center.id} className="center-item">
              <h4>{center.name}</h4>
              <p>Priority: {center.priority}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Utility function for debouncing
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

export default AddressAutocomplete;
```

### API Response Examples

#### Address Suggestions Response
```json
{
  "success": true,
  "data": [
    {
      "placeId": "ChIJaT3hVIpiSoYR73eUv5oiFgU",
      "description": "123 N Main St, Detroit, TX 75436, USA",
      "mainText": "123 N Main St",
      "secondaryText": "Detroit, TX 75436, USA"
    }
  ],
  "message": "Found 1 address suggestions",
  "input": "123 Main St Detroit"
}
```

#### Address Validation Response
```json
{
  "success": true,
  "data": {
    "placeId": "ChIJaT3hVIpiSoYR73eUv5oiFgU",
    "formattedAddress": "123 N Main St, Detroit, TX 75436, USA",
    "zipcode": "75436",
    "city": "Detroit",
    "state": "Texas",
    "country": "United States",
    "coordinates": {
      "lat": 33.6633458,
      "lng": -95.2663066
    }
  },
  "message": "Address validated successfully"
}
```

## Setup Instructions

### 1. Installation & Running

```bash
# Install dependencies
npm install

# Start the server
npm start

# For development with auto-restart
npm run dev
```

### 2. Data Setup
The application uses provider data stored in `src/data/provider.js`:

- **16 Active Providers** with real Zenoti center IDs
- **274+ Unique Zipcodes** covered
- **Priority-based ordering** (1-16 scale)
- **Active/inactive status** tracking

```javascript
// src/data/provider.js
const providers = [
  {
    name: "Lindsey Oliver, PA-C",
    provider_id: "568fdbef-f527-40f9-a428-34a57383dab4", // Matches Zenoti center ID
    zipCodes: ["48236", "48230", "48080", "48082", "48081"],
    status: "active",
    priority: 2,
  },
  // ... 15 more providers
];
```

## Usage Examples

### 1. Address Validation Flow

```javascript
// Get address suggestions
const suggestions = await fetch('/api/address/suggestions?input=123 Main St');

// Validate selected address
const address = await fetch('/api/address/validate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ placeId: 'ChIJ...' })
});

// Find centers for the address
const centers = await fetch('/api/address/centers', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: validatedAddress })
});
```

### 2. Service Selection Flow

```javascript
// Get common services across centers
const services = await fetch('/api/services/common', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    centerIds: ['center-001', 'center-002'] 
  })
});

// Calculate price for selected services
const pricing = await fetch('/api/services/calculate-price', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    serviceIds: ['service-001', 'service-002'],
    centerIds: ['center-001', 'center-002']
  })
});
```

### 3. Booking Flow

```javascript
// Get available time slots
const timeSlots = await fetch('/api/booking/availability', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    centerIds: ['center-001', 'center-002'],
    date: '2024-01-15',
    serviceIds: ['service-001', 'service-002'],
    duration: 120
  })
});

// Create booking
const booking = await fetch('/api/booking/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user-123',
    address: validatedAddress,
    selectedServices: ['service-001', 'service-002'],
    selectedDate: '2024-01-15',
    selectedTimeSlot: selectedTimeSlot,
    customerInfo: {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john@example.com',
      phone: '+1234567890'
    }
  })
});
```

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Frontend      │    │   API Layer      │    │   Zenoti API    │
│   (React/Next)  │◄──►│   (Express.js)   │◄──►│   (External)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │   JSON Files     │
                       │   (centers.json, │
                       │   services.json, │
                       │   bookings.json) │
                       └──────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │  Google Places   │
                       │      API         │
                       └──────────────────┘
```

## Key Features

- **Address Validation**: Google Places API integration for accurate address handling
- **Center Priority**: Intelligent center selection based on priority and availability
- **Service Aggregation**: Smart filtering to show only common services across centers
- **Real-time Pricing**: Dynamic price calculation for multiple services
- **Booking Management**: Complete booking lifecycle with confirmation and cancellation
- **Error Handling**: Comprehensive error handling and validation
- **Type Safety**: Full TypeScript implementation for better development experience
- **Security**: Rate limiting, API key validation, and security headers
- **JSON Storage**: Lightweight file-based data storage

## Security Features

- **Rate Limiting**: 100 requests per 15-minute window per IP
- **API Key Protection**: Optional API key validation for additional security
- **Security Headers**: XSS protection, content type sniffing prevention
- **CORS Protection**: Configurable origin restrictions
- **Request Logging**: Detailed request/response logging
- **Environment Separation**: Different configurations for dev/production

## Development

The project uses TypeScript with Express.js and includes:
- Input validation using Joi
- Error handling middleware
- Logging utilities
- Database abstraction layer
- External API clients

## License

MIT License - see LICENSE file for details
