/**
 * Weather Oracle — NOAA GFS via Open-Meteo API
 * 
 * Free, no API key, global coverage.
 * Uses GFS/ECMWF ensemble for probability estimation.
 * 
 * Key insight: Open-Meteo provides not just point forecasts but 
 * ensemble members, letting us compute actual probability distributions.
 */

// City coordinates for common Polymarket weather markets
const CITY_COORDS: Record<string, { lat: number; lon: number; tz: string }> = {
  'paris':     { lat: 48.8566, lon: 2.3522, tz: 'Europe/Paris' },
  'london':    { lat: 51.5074, lon: -0.1278, tz: 'Europe/London' },
  'tokyo':     { lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
  'seoul':     { lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul' },
  'toronto':   { lat: 43.6532, lon: -79.3832, tz: 'America/Toronto' },
  'new york':  { lat: 40.7128, lon: -74.0060, tz: 'America/New_York' },
  'nyc':       { lat: 40.7128, lon: -74.0060, tz: 'America/New_York' },
  'miami':     { lat: 25.7617, lon: -80.1918, tz: 'America/New_York' },
  'dallas':    { lat: 32.7767, lon: -96.7970, tz: 'America/Chicago' },
  'chicago':   { lat: 41.8781, lon: -87.6298, tz: 'America/Chicago' },
  'los angeles': { lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles' },
  'la':        { lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles' },
  'munich':    { lat: 48.1351, lon: 11.5820, tz: 'Europe/Berlin' },
  'berlin':    { lat: 52.5200, lon: 13.4050, tz: 'Europe/Berlin' },
  'sydney':    { lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney' },
  'mumbai':    { lat: 19.0760, lon: 72.8777, tz: 'Asia/Kolkata' },
  'delhi':     { lat: 28.6139, lon: 77.2090, tz: 'Asia/Kolkata' },
  'lucknow':   { lat: 26.8467, lon: 80.9462, tz: 'Asia/Kolkata' },
  'beijing':   { lat: 39.9042, lon: 116.4074, tz: 'Asia/Shanghai' },
  'dubai':     { lat: 25.2048, lon: 55.2708, tz: 'Asia/Dubai' },
  'mexico city': { lat: 19.4326, lon: -99.1332, tz: 'America/Mexico_City' },
  'são paulo': { lat: -23.5505, lon: -46.6333, tz: 'America/Sao_Paulo' },
  'sao paulo': { lat: -23.5505, lon: -46.6333, tz: 'America/Sao_Paulo' },
};

interface WeatherForecast {
  city: string;
  date: string;
  highC: number;
  lowC: number;
  highF: number;
  lowF: number;
  precipMm: number;
  precipProb: number;
}

interface WeatherProbability {
  question: string;
  city: string;
  date: string;
  forecast: WeatherForecast;
  probability: number;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  source: 'open-meteo-gfs';
}

/**
 * Extract city name from a weather market question
 */
export function extractCity(question: string): string | null {
  const q = question.toLowerCase();
  // Try longest match first
  const cities = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const city of cities) {
    if (q.includes(city)) return city;
  }
  return null;
}

/**
 * Extract target date from question (e.g., "on March 11" → "2026-03-11")
 */
export function extractDate(question: string): string | null {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  
  // Match explicit month names to avoid false positives like "in 9"
  const match = question.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (match) {
    const month = months[match[1].toLowerCase()];
    if (month) {
      const day = match[2].padStart(2, '0');
      const year = match[3] || new Date().getFullYear().toString();
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

/**
 * Parse what the question is asking about temperature
 */
interface TempCondition {
  type: 'exact' | 'above' | 'below' | 'range';
  metric: 'high' | 'low';
  unit: 'C' | 'F';
  value?: number;
  min?: number;
  max?: number;
}

export function parseTempCondition(question: string): TempCondition | null {
  const q = question;
  
  // "highest temperature ... be 9°C" (exact)
  let m = q.match(/(?:highest|high)\s+temp.*?(?:be\s+)?(\d+)°([CF])\b(?:\s+on)/i);
  if (m) return { type: 'exact', metric: 'high', unit: m[2] as 'C'|'F', value: parseInt(m[1]) };
  
  // "highest temperature ... be between 80-81°F"
  m = q.match(/(?:highest|high)\s+temp.*?(?:between\s+)?(\d+)[-–](\d+)°([CF])/i);
  if (m) return { type: 'range', metric: 'high', unit: m[3] as 'C'|'F', min: parseInt(m[1]), max: parseInt(m[2]) };
  
  // "highest temperature ... be 10°C or below"
  m = q.match(/(?:highest|high)\s+temp.*?(\d+)°([CF])\s+or\s+(below|lower)/i);
  if (m) return { type: 'below', metric: 'high', unit: m[2] as 'C'|'F', value: parseInt(m[1]) };
  
  // "highest temperature ... be 44°C or higher"
  m = q.match(/(?:highest|high)\s+temp.*?(\d+)°([CF])\s+or\s+(higher|above)/i);
  if (m) return { type: 'above', metric: 'high', unit: m[2] as 'C'|'F', value: parseInt(m[1]) };
  
  // Same patterns for lowest
  m = q.match(/(?:lowest|low)\s+temp.*?(?:be\s+)?(\d+)°([CF])\b/i);
  if (m) return { type: 'exact', metric: 'low', unit: m[2] as 'C'|'F', value: parseInt(m[1]) };
  
  return null;
}

/**
 * Fetch forecast from Open-Meteo (GFS-backed)
 */
export async function fetchForecast(city: string, days: number = 7): Promise<WeatherForecast[]> {
  const coords = CITY_COORDS[city.toLowerCase()];
  if (!coords) throw new Error(`Unknown city: ${city}`);
  
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=${encodeURIComponent(coords.tz)}&forecast_days=${days}&models=gfs_seamless`;
  
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);
  const data = await res.json();
  
  const daily = data.daily;
  const forecasts: WeatherForecast[] = [];
  
  for (let i = 0; i < daily.time.length; i++) {
    const highC = daily.temperature_2m_max[i];
    const lowC = daily.temperature_2m_min[i];
    forecasts.push({
      city,
      date: daily.time[i],
      highC,
      lowC,
      highF: Math.round(highC * 9/5 + 32),
      lowF: Math.round(lowC * 9/5 + 32),
      precipMm: daily.precipitation_sum?.[i] ?? 0,
      precipProb: daily.precipitation_probability_max?.[i] ?? 0,
    });
  }
  
  return forecasts;
}

/**
 * Estimate probability using GFS forecast + historical forecast error margins
 * 
 * GFS error margins (MAE, °C):
 * Day 1: ±1.0°C | Day 2: ±1.5°C | Day 3: ±2.0°C | Day 4+: ±2.5-3.0°C
 * 
 * We model forecast error as normal distribution with these σ values
 */
function normalCDF(x: number, mean: number, stddev: number): number {
  // Approximation of the standard normal CDF
  const z = (x - mean) / stddev;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327; // 1/sqrt(2π)
  const p = d * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

function getForcastStdDev(daysAhead: number): number {
  // GFS temperature forecast standard deviation by lead time
  if (daysAhead <= 1) return 1.2;
  if (daysAhead <= 2) return 1.8;
  if (daysAhead <= 3) return 2.3;
  if (daysAhead <= 5) return 3.0;
  return 3.5; // 5+ days
}

/**
 * Main function: estimate probability for a weather market question
 */
export async function estimateWeatherProbability(question: string): Promise<WeatherProbability | null> {
  const city = extractCity(question);
  if (!city) return null;
  
  const dateStr = extractDate(question);
  if (!dateStr) return null;
  
  const condition = parseTempCondition(question);
  if (!condition) return null;
  
  const forecasts = await fetchForecast(city);
  const forecast = forecasts.find(f => f.date === dateStr);
  if (!forecast) return null;
  
  // Calculate days ahead
  const today = new Date();
  const targetDate = new Date(dateStr);
  const daysAhead = Math.max(0, Math.ceil((targetDate.getTime() - today.getTime()) / 86400000));
  const stddev = getForcastStdDev(daysAhead);
  
  // Get the relevant forecast value
  const forecastValue = condition.metric === 'high' 
    ? (condition.unit === 'C' ? forecast.highC : forecast.highF)
    : (condition.unit === 'C' ? forecast.lowC : forecast.lowF);
  
  // Convert stddev if Fahrenheit
  const sd = condition.unit === 'F' ? stddev * 9/5 : stddev;
  
  let probability: number;
  let reasoning: string;
  
  switch (condition.type) {
    case 'exact': {
      // P(value - 0.5 < actual < value + 0.5)
      const v = condition.value!;
      probability = normalCDF(v + 0.5, forecastValue, sd) - normalCDF(v - 0.5, forecastValue, sd);
      reasoning = `GFS forecasts ${forecastValue}°${condition.unit} ± ${sd.toFixed(1)}°. P(exact ${v}°) = ${(probability*100).toFixed(1)}%`;
      break;
    }
    case 'above': {
      // P(actual >= value)
      const v = condition.value!;
      probability = 1 - normalCDF(v - 0.5, forecastValue, sd);
      reasoning = `GFS forecasts ${forecastValue}°${condition.unit} ± ${sd.toFixed(1)}°. P(≥${v}°) = ${(probability*100).toFixed(1)}%`;
      break;
    }
    case 'below': {
      // P(actual <= value)
      const v = condition.value!;
      probability = normalCDF(v + 0.5, forecastValue, sd);
      reasoning = `GFS forecasts ${forecastValue}°${condition.unit} ± ${sd.toFixed(1)}°. P(≤${v}°) = ${(probability*100).toFixed(1)}%`;
      break;
    }
    case 'range': {
      // P(min <= actual <= max)
      const lo = condition.min!;
      const hi = condition.max!;
      probability = normalCDF(hi + 0.5, forecastValue, sd) - normalCDF(lo - 0.5, forecastValue, sd);
      reasoning = `GFS forecasts ${forecastValue}°${condition.unit} ± ${sd.toFixed(1)}°. P(${lo}–${hi}°) = ${(probability*100).toFixed(1)}%`;
      break;
    }
  }
  
  // Confidence based on days ahead
  const confidence = daysAhead <= 2 ? 'high' : daysAhead <= 4 ? 'medium' : 'low';
  
  return {
    question,
    city,
    date: dateStr,
    forecast,
    probability: Math.round(probability * 1000) / 1000,
    confidence,
    reasoning,
    source: 'open-meteo-gfs',
  };
}
