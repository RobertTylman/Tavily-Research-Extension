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

export function CitationList({ citations }: CitationListProps) {
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

    const geocodeForActiveCitations = async () => {
      const candidates = activeCitations
        .map((citation) => ({
          citation,
          query: extractLocationQuery(citation),
        }))
        .filter((item): item is { citation: Citation; query: string } => Boolean(item.query))
        .slice(0, 7);

      const resolved = await Promise.all(
        candidates.map(async ({ citation, query }) => {
          const point = await geocodeLocation(query);
          if (!point) {
            return null;
          }
          return { citation, query, point };
        })
      );

      if (!cancelled) {
        setGeocodedCitations(resolved.filter((item): item is GeocodedCitation => item !== null));
      }
    };

    geocodeForActiveCitations().catch(() => {
      if (!cancelled) {
        setGeocodedCitations([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeCitations]);

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

  return (
    <div className="citations-list">
      <h4 className="citations-heading">Sources Timeline & Map</h4>

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
                  <strong>{entry.citation.title || entry.citation.source}</strong>
                  <div>{entry.point.displayName}</div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
        {geocodedCitations.length === 0 && (
          <p className="timeline-note">
            No mappable locations detected from the currently selected articles.
          </p>
        )}
      </div>

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

async function geocodeLocation(query: string): Promise<GeocodePoint | null> {
  if (geocodeCache.has(query)) {
    return geocodeCache.get(query) || null;
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(
        query
      )}`,
      {
        headers: {
          Accept: 'application/json',
        },
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
    }>;
    const top = data[0];
    if (!top?.lat || !top?.lon) {
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

function extractLocationQuery(citation: Citation): string | null {
  const combined = `${citation.title || ''}. ${citation.snippet || ''}`.trim();
  const lowered = combined.toLowerCase();

  const knownLocations: Array<{ pattern: RegExp; label: string }> = [
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

  for (const location of knownLocations) {
    if (location.pattern.test(lowered)) {
      return location.label;
    }
  }

  const prepositionMatch = combined.match(
    /\b(?:in|at|near|from|around|off|between)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/
  );
  if (prepositionMatch?.[1]) {
    return prepositionMatch[1].trim();
  }

  const properNouns = [...combined.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)]
    .map((item) => item[1])
    .filter((term) => !NON_LOCATION_TERMS.has(term.toLowerCase()));

  return properNouns.length > 0 ? properNouns[0] : null;
}

const NON_LOCATION_TERMS = new Set([
  'reuters',
  'associated press',
  'ap',
  'bbc',
  'cnn',
  'tavily',
  'fact checker',
  'fact-check',
  'openai',
]);
