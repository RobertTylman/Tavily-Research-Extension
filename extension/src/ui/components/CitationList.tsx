/**
 * Citation List Component
 *
 * Displays sources used to verify a claim, with:
 * - Month-based timeline slider
 * - Map view for detected locations in article text
 * - Rich article metadata
 */

import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { Citation } from '../../lib/types';

interface CitationListProps {
  citations: Citation[];
  claimText: string;
}

interface TimelineBucket {
  key: string;
  label: string;
  citations: Citation[];
  date: Date;
}

interface GeocodePoint {
  lat: number;
  lon: number;
  displayName: string;
}

interface GeocodedCitation {
  citation: Citation;
  query: string;
  point: GeocodePoint;
}

const DEFAULT_CENTER: [number, number] = [20, 0];
const geocodeCache = new Map<string, GeocodePoint | null>();

const defaultMarkerIcon = L.icon({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

L.Marker.prototype.options.icon = defaultMarkerIcon;

export function CitationList({ citations, claimText }: CitationListProps) {
  const timelineBuckets = useMemo(() => buildTimelineBuckets(citations), [citations]);
  const [selectedBucketIndex, setSelectedBucketIndex] = useState(0);
  const [geocodedCitations, setGeocodedCitations] = useState<GeocodedCitation[]>([]);

  useEffect(() => {
    if (timelineBuckets.length > 0) {
      setSelectedBucketIndex(timelineBuckets.length - 1);
    } else {
      setSelectedBucketIndex(0);
    }
  }, [timelineBuckets.length]);

  const activeBucket =
    timelineBuckets.length > 0
      ? timelineBuckets[Math.min(selectedBucketIndex, timelineBuckets.length - 1)]
      : null;

  const activeCitations = activeBucket ? activeBucket.citations : citations;

  useEffect(() => {
    let cancelled = false;

    const geocodeForClaim = async () => {
      const candidateQueries = extractClaimLocations(claimText).slice(0, 5);
      if (candidateQueries.length === 0) {
        if (!cancelled) setGeocodedCitations([]);
        return;
      }

      const points: { query: string; point: GeocodePoint }[] = [];
      for (const query of candidateQueries) {
        const point = await geocodeLocation(query);
        if (point) {
          points.push({ query, point });
        }
      }

      const resolved: GeocodedCitation[] = [];
      for (const { query, point } of points) {
        const matchedCitation =
          activeCitations.find((c) => mentionsLocation(c, query)) || activeCitations[0];
        if (matchedCitation) {
          resolved.push({ citation: matchedCitation, query, point });
        }
      }

      if (!cancelled) {
        setGeocodedCitations(resolved);
      }
    };

    geocodeForClaim().catch(() => {
      if (!cancelled) {
        setGeocodedCitations([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [claimText, activeCitations]);

  const mapCenter: [number, number] = geocodedCitations.length
    ? [geocodedCitations[0].point.lat, geocodedCitations[0].point.lon]
    : DEFAULT_CENTER;
  const mapZoom = geocodedCitations.length ? 4 : 2;
  const mapKey = geocodedCitations.length
    ? `${geocodedCitations[0].point.lat}-${geocodedCitations[0].point.lon}-${geocodedCitations.length}`
    : 'empty-map';

  if (citations.length === 0) {
    return null;
  }

  const showMap = geocodedCitations.length > 0;

  return (
    <div className="citations-list">
      <h4 className="citations-heading">
        {showMap ? 'Sources Timeline & Map' : 'Sources Timeline'}
      </h4>

      {timelineBuckets.length > 1 && (
        <div className="timeline-control">
          <div className="timeline-header">
            <span>Time Focus</span>
            <span>{activeBucket?.label}</span>
          </div>
          <input
            type="range"
            min={0}
            max={timelineBuckets.length - 1}
            step={1}
            value={Math.min(selectedBucketIndex, timelineBuckets.length - 1)}
            onChange={(event) => setSelectedBucketIndex(parseInt(event.target.value, 10))}
            className="timeline-slider"
          />
          <p className="timeline-note">
            Showing {activeCitations.length} article
            {activeCitations.length === 1 ? '' : 's'} from {activeBucket?.label}
          </p>
        </div>
      )}

      {showMap && (
        <div className="citation-map-wrapper">
          <MapContainer
            key={mapKey}
            center={mapCenter}
            zoom={mapZoom}
            className="citation-map"
            scrollWheelZoom={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {geocodedCitations.map((entry) => (
              <Marker
                key={`${entry.citation.url}-${entry.query}`}
                position={[entry.point.lat, entry.point.lon]}
              >
                <Popup>
                  <div className="map-popup">
                    <strong>{entry.point.displayName}</strong>
                    <div>Mentioned in claim: "{entry.query}"</div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}

      {activeCitations.map((citation, index) => (
        <div key={`${citation.url}-${index}`} className="citation-item">
          <div className="citation-header">
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="citation-source"
            >
              {citation.title || citation.source}
            </a>
            <span className="citation-link-icon">↗</span>
          </div>
          <div className="citation-meta">
            {citation.publishedDate && (
              <span className="meta-pill">{formatDisplayDate(citation.publishedDate)}</span>
            )}
            {typeof citation.authority === 'number' && (
              <span className="meta-pill">Authority {citation.authority.toFixed(2)}</span>
            )}
            {citation.stance && <span className="meta-pill">{citation.stance}</span>}
            {citation.entailmentProvider && (
              <span className="meta-pill">{citation.entailmentProvider}</span>
            )}
          </div>
          <p className="citation-snippet">"{citation.snippet}"</p>
          {citation.reasoning && (
            <p className="citation-reasoning">Reasoning: {citation.reasoning}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function buildTimelineBuckets(citations: Citation[]): TimelineBucket[] {
  const monthly = new Map<string, { citations: Citation[]; date: Date }>();

  for (const citation of citations) {
    const parsedDate = parsePublishedDate(citation.publishedDate);
    if (!parsedDate) {
      continue;
    }

    const key = `${parsedDate.getUTCFullYear()}-${String(parsedDate.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}`;
    const monthDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), 1));
    const existing = monthly.get(key);
    if (existing) {
      existing.citations.push(citation);
    } else {
      monthly.set(key, { citations: [citation], date: monthDate });
    }
  }

  return Array.from(monthly.entries())
    .map(([key, value]) => ({
      key,
      label: new Intl.DateTimeFormat('en-US', {
        month: 'short',
        year: 'numeric',
      }).format(value.date),
      citations: value.citations.sort(
        (a, b) =>
          (parsePublishedDate(b.publishedDate)?.getTime() || 0) -
          (parsePublishedDate(a.publishedDate)?.getTime() || 0)
      ),
      date: value.date,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function parsePublishedDate(value?: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDisplayDate(value: string): string {
  const parsed = parsePublishedDate(value);
  if (!parsed) {
    return value;
  }
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
  }).format(parsed);
}

const PLACE_CLASSES = new Set(['place', 'boundary', 'natural', 'waterway']);

async function geocodeLocation(query: string): Promise<GeocodePoint | null> {
  if (geocodeCache.has(query)) {
    return geocodeCache.get(query) || null;
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(
        query
      )}`,
      {
        headers: { Accept: 'application/json' },
      }
    );
    if (!response.ok) {
      geocodeCache.set(query, null);
      return null;
    }

    const data = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
      class?: string;
      importance?: number;
    }>;
    const top = data[0];

    // Require Nominatim to classify this as an actual place (not a person, business,
    // university, etc). This filters out false positives like "Donald Trump" matching
    // a person record or a Trump Tower entry.
    if (!top?.lat || !top?.lon || !top.class || !PLACE_CLASSES.has(top.class)) {
      geocodeCache.set(query, null);
      return null;
    }

    if (typeof top.importance === 'number' && top.importance < 0.4) {
      geocodeCache.set(query, null);
      return null;
    }

    const point = {
      lat: parseFloat(top.lat),
      lon: parseFloat(top.lon),
      displayName: top.display_name || query,
    };
    if (Number.isNaN(point.lat) || Number.isNaN(point.lon)) {
      geocodeCache.set(query, null);
      return null;
    }

    geocodeCache.set(query, point);
    return point;
  } catch {
    geocodeCache.set(query, null);
    return null;
  }
}

const KNOWN_LOCATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bstrait of hormuz\b/i, label: 'Strait of Hormuz' },
  { pattern: /\bgaza\b/i, label: 'Gaza' },
  { pattern: /\bisrael\b/i, label: 'Israel' },
  { pattern: /\biran\b/i, label: 'Iran' },
  { pattern: /\bukraine\b/i, label: 'Ukraine' },
  { pattern: /\brussia\b/i, label: 'Russia' },
  { pattern: /\bred sea\b/i, label: 'Red Sea' },
  { pattern: /\blebanon\b/i, label: 'Lebanon' },
  { pattern: /\byemen\b/i, label: 'Yemen' },
  { pattern: /\bsyria\b/i, label: 'Syria' },
];

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'from',
  'by',
  'as',
  'is',
  'was',
  'were',
  'are',
  'be',
  'been',
  'has',
  'have',
  'had',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
]);

/**
 * Pull location candidates out of the *claim* text only. We look for capitalized
 * multi-word phrases (likely proper nouns) and rely on Nominatim's `class` field
 * to reject person/business names downstream. Single capitalized words are only
 * accepted at the start of a sentence if they aren't a leading-stopword.
 */
function extractClaimLocations(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const { pattern, label } of KNOWN_LOCATION_PATTERNS) {
    if (pattern.test(text) && !seen.has(label.toLowerCase())) {
      candidates.push(label);
      seen.add(label.toLowerCase());
    }
  }

  // Multi-word capitalized phrases (e.g. "Cape Town", "New York City").
  const phraseMatches = [...text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)];
  for (const match of phraseMatches) {
    const phrase = match[1].trim();
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    if (STOPWORDS.has(key.split(' ')[0])) continue;
    candidates.push(phrase);
    seen.add(key);
  }

  // Prepositional single-word locations (e.g. "in Pennsylvania", "near Tehran").
  const prepMatches = [...text.matchAll(/\b(?:in|at|near|from|off)\s+([A-Z][a-z]{3,})\b/g)];
  for (const match of prepMatches) {
    const word = match[1].trim();
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    candidates.push(word);
    seen.add(key);
  }

  return candidates;
}

function mentionsLocation(citation: Citation, location: string): boolean {
  const haystack = `${citation.title || ''} ${citation.snippet || ''}`.toLowerCase();
  return haystack.includes(location.toLowerCase());
}
