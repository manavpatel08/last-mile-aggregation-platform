"use client";

import React, { useEffect, useRef } from "react";
import L from "leaflet";

interface DriverGps {
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
}

export interface PassengerMapInfo {
  id: string;
  fullName: string;
  status: string;
  destination?: {
    latitude: number;
    longitude: number;
    name: string;
  };
}

interface LiveMapProps {
  driverGps?: DriverGps | null;
  routeGeometry?: any | null;
  passengers?: PassengerMapInfo[];
}

export const LiveMap: React.FC<LiveMapProps> = ({
  driverGps,
  routeGeometry,
  passengers,
}) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const driverMarkerRef = useRef<L.Marker | null>(null);
  const routePolylineRef = useRef<L.Polyline | null>(null);
  const destMarkersRef = useRef<L.Marker[]>([]);

  // Origin Hub: PDEU Demo Station
  const DEMO_STATION_COORDS: [number, number] = [23.155, 72.6668];

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Initialize Leaflet map
    const map = L.map(mapContainerRef.current, {
      center: DEMO_STATION_COORDS,
      zoom: 13,
      zoomControl: true,
    });

    // Add free OpenStreetMap tile layer
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 18,
    }).addTo(map);

    // 1. Hub Marker: PDEU Demo Station
    const hubIcon = L.divIcon({
      className: "custom-hub-marker",
      html: `
        <div style="background-color: #059669; color: white; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3); border: 2px solid white; font-weight: bold; font-size: 14px;">
          H
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    L.marker(DEMO_STATION_COORDS, { icon: hubIcon })
      .addTo(map)
      .bindPopup("<b>PDEU Demo Station Hub</b><br>Simulation Origin Pickup Station");

    // 2. Driver Vehicle Marker
    const driverIcon = L.divIcon({
      className: "custom-driver-marker",
      html: `
        <div style="background-color: #d97706; color: white; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(217,119,6,0.6); border: 3px solid white; font-size: 18px;">
          🛺
        </div>
      `,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

    const initDriverPos = driverGps
      ? [driverGps.latitude, driverGps.longitude]
      : DEMO_STATION_COORDS;

    const driverMarker = L.marker(initDriverPos as [number, number], {
      icon: driverIcon,
      zIndexOffset: 1000,
    })
      .addTo(map)
      .bindPopup("<b>Driver Ramesh</b><br>Mahindra Treo Electric (GJ-01-DM-0001)");

    driverMarkerRef.current = driverMarker;
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Update Dynamic Destination Markers from actual booking destinations
  useEffect(() => {
    if (!mapRef.current) return;

    // Clear previous destination markers
    destMarkersRef.current.forEach((m) => m.remove());
    destMarkersRef.current = [];

    if (!passengers || passengers.length === 0) return;

    passengers.forEach((p, idx) => {
      if (p.destination?.latitude && p.destination?.longitude) {
        const destIcon = L.divIcon({
          className: `custom-dest-marker-${idx}`,
          html: `
            <div style="background-color: ${idx === 0 ? "#2563eb" : "#7c3aed"}; color: white; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3); border: 2px solid white; font-weight: bold; font-size: 11px;">
              P${idx + 1}
            </div>
          `,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });

        const marker = L.marker(
          [p.destination.latitude, p.destination.longitude],
          { icon: destIcon }
        )
          .addTo(mapRef.current!)
          .bindPopup(
            `<b>${p.destination.name || "Drop-off Destination"}</b><br>${p.fullName} (${p.status})`
          );

        destMarkersRef.current.push(marker);
      }
    });
  }, [passengers]);

  // Update Driver Marker Position when driverGps changes
  useEffect(() => {
    if (!driverMarkerRef.current || !driverGps) return;
    const newPos: [number, number] = [driverGps.latitude, driverGps.longitude];
    driverMarkerRef.current.setLatLng(newPos);

    if (mapRef.current) {
      mapRef.current.panTo(newPos, { animate: true });
    }
  }, [driverGps?.latitude, driverGps?.longitude]);

  // Update Route Polyline when routeGeometry changes
  useEffect(() => {
    if (!mapRef.current) return;

    if (routePolylineRef.current) {
      routePolylineRef.current.remove();
      routePolylineRef.current = null;
    }

    if (routeGeometry && routeGeometry.coordinates && Array.isArray(routeGeometry.coordinates)) {
      // GeoJSON has coordinates as [longitude, latitude]
      // Leaflet expects [latitude, longitude]
      const latLngs: [number, number][] = routeGeometry.coordinates.map(
        (c: [number, number]) => [c[1], c[0]]
      );

      if (latLngs.length > 0) {
        const polyline = L.polyline(latLngs, {
          color: "#4f46e5",
          weight: 5,
          opacity: 0.85,
          lineJoin: "round",
        }).addTo(mapRef.current);

        routePolylineRef.current = polyline;
        mapRef.current.fitBounds(polyline.getBounds(), { padding: [40, 40] });
      }
    }
  }, [routeGeometry]);

  return (
    <div className="relative w-full h-[480px] rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-slate-100">
      <div ref={mapContainerRef} className="w-full h-full z-0" />

      {/* Floating Legend */}
      <div className="absolute bottom-4 left-4 z-[500] bg-white/95 backdrop-blur px-3 py-2.5 rounded-xl border border-slate-200 shadow-lg text-xs space-y-1.5 text-slate-700">
        <div className="font-semibold text-slate-900 border-b pb-1">
          Corridor Route Legend
        </div>
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full bg-emerald-600 inline-block" />
          <span>PDEU Demo Station (Origin Hub)</span>
        </div>
        {passengers &&
          passengers.map((p, idx) =>
            p.destination ? (
              <div key={p.id} className="flex items-center space-x-2">
                <span
                  className={`w-3 h-3 rounded-full inline-block ${
                    idx === 0 ? "bg-blue-600" : "bg-purple-600"
                  }`}
                />
                <span>{p.destination.name}</span>
              </div>
            ) : null
          )}
        <div className="flex items-center space-x-2">
          <span className="w-3 h-3 rounded-full bg-amber-500 inline-block" />
          <span>E-Rickshaw Live GPS</span>
        </div>
      </div>
    </div>
  );
};
