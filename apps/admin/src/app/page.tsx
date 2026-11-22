"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { Header } from "../components/Header";
import { JourneyStatusCard } from "../components/JourneyStatusCard";
import { SimulationControls } from "../components/SimulationControls";
import { EventTimeline, SocketEventLog } from "../components/EventTimeline";
import {
  adminLogin,
  provisionAgents,
  createDemoBookings,
  triggerMatching,
  getActiveJourney,
  progressStep,
  updateDriverLocation,
  resetSimulation,
  connectAdminSocket,
} from "../lib/api";

// Dynamically import LiveMap with SSR disabled to prevent Leaflet window errors
const LiveMap = dynamic(
  () => import("../components/LiveMap").then((mod) => mod.LiveMap),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-[480px] rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400 text-sm border border-slate-200">
        Loading OpenStreetMap & Leaflet engine...
      </div>
    ),
  }
);

// Extract waypoints dynamically from OSRM GeoJSON LineString (no hardcoded GPS path)
function getRouteWaypoints(geometry: any): Array<{ lat: number; lng: number }> {
  if (
    geometry?.coordinates &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0
  ) {
    return geometry.coordinates.map((c: [number, number]) => ({
      lat: c[1],
      lng: c[0],
    }));
  }
  return [];
}

export default function SimulationDashboardPage() {
  const [adminUser, setAdminUser] = useState<any>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [journey, setJourney] = useState<any>(null);
  const [events, setEvents] = useState<SocketEventLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [driverGps, setDriverGps] = useState<{
    latitude: number;
    longitude: number;
  }>({
    latitude: 23.155,
    longitude: 72.6668,
  });

  const waypointIndexRef = useRef(0);
  const driverUserIdRef = useRef<string | null>(null);

  // Helper to append a socket event to timeline
  const addEvent = useCallback(
    (name: string, data: any, time: string = new Date().toLocaleTimeString()) => {
      setEvents((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          name,
          time,
          data,
        },
        ...prev.slice(0, 49), // retain last 50 events
      ]);
    },
    []
  );

  // Fetch Authoritative Journey State
  const refreshJourney = useCallback(async () => {
    try {
      const res = await getActiveJourney();
      if (res.data) {
        setJourney(res.data);
        if (res.data.driver?.userId) {
          driverUserIdRef.current = res.data.driver.userId;
        }
        if (res.data.driver?.currentGps) {
          setDriverGps({
            latitude: res.data.driver.currentGps.latitude,
            longitude: res.data.driver.currentGps.longitude,
          });
        }
      }
    } catch (err: any) {
      console.error("Failed to fetch active journey:", err);
    }
  }, []);

  // Initialize Admin Auth & Realtime Socket
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        setLoading(true);
        // 1. Admin login
        const authData = await adminLogin();
        if (!mounted) return;
        setAdminUser(authData.user);

        // 2. Initial journey fetch
        await refreshJourney();

        // 3. Connect Realtime WebSocket
        await connectAdminSocket((evt) => {
          if (!mounted) return;
          if (evt.name === "connected") {
            setSocketConnected(true);
          }
          if (evt.name === "driver.location.updated") {
            setDriverGps({
              latitude: evt.data.latitude,
              longitude: evt.data.longitude,
            });
          }
          addEvent(evt.name, evt.data, evt.time);
          refreshJourney();
        });
      } catch (err: any) {
        console.error("Initialization error:", err);
        setLastMessage(`Init error: ${err.message}`);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [addEvent, refreshJourney]);

  // Actions
  const handleProvisionAgents = async () => {
    try {
      setLoading(true);
      const res = await provisionAgents();
      if (res.data?.driver?.userId) {
        driverUserIdRef.current = res.data.driver.userId;
      }
      setLastMessage(
        "Virtual agents provisioned: 2 passengers & Driver Ramesh (Approved, E-Rickshaw)"
      );
      addEvent("agents.provisioned", res.data);
      await refreshJourney();
    } catch (err: any) {
      setLastMessage(`Error provisioning agents: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateBookings = async () => {
    try {
      setLoading(true);
      const res = await createDemoBookings();
      setLastMessage(
        "2 shared bookings created: PDEU Demo Station -> Bhaijipura Circle & Kudasan"
      );
      addEvent("bookings.created", res.data);
      await refreshJourney();
    } catch (err: any) {
      setLastMessage(`Error creating bookings: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerMatching = async () => {
    try {
      setLoading(true);
      const res = await triggerMatching("PDEU Demo Station");
      setLastMessage(
        `Matching cycle executed for PDEU Demo Station. Formed groups: ${res.data?.groupsFormedCount || 0}`
      );
      addEvent("matching.executed", res.data);
      await refreshJourney();
    } catch (err: any) {
      setLastMessage(`Error executing matching: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleProgressStep = async () => {
    try {
      setLoading(true);
      const res = await progressStep();
      setLastMessage(res.data?.message || "Lifecycle step progressed");
      addEvent(`lifecycle.${res.data?.stepExecuted?.toLowerCase()}`, res.data);
      await refreshJourney();
    } catch (err: any) {
      setLastMessage(`Error stepping lifecycle: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSimulateGps = async () => {
    try {
      const driverId = driverUserIdRef.current || journey?.driver?.userId;
      if (!driverId) {
        setLastMessage("Cannot simulate GPS: No driver assigned yet.");
        return;
      }

      const waypoints = getRouteWaypoints(journey?.route?.geometry);
      if (waypoints.length === 0) {
        setLastMessage(
          "Route geometry is unavailable or invalid from backend. Driver GPS simulation is disabled."
        );
        return;
      }

      waypointIndexRef.current =
        (waypointIndexRef.current + 1) % waypoints.length;
      const targetPoint = waypoints[waypointIndexRef.current];

      const res = await updateDriverLocation(
        driverId,
        targetPoint.lat,
        targetPoint.lng
      );
      setDriverGps({ latitude: targetPoint.lat, longitude: targetPoint.lng });
      setLastMessage(
        `Driver GPS updated: (${targetPoint.lat.toFixed(4)}, ${targetPoint.lng.toFixed(4)})`
      );
    } catch (err: any) {
      setLastMessage(`Error updating GPS: ${err.message}`);
    }
  };

  const handleAutoRun = async () => {
    setAutoRunning(true);
    setLastMessage("Starting automated full journey demonstration...");

    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    try {
      // 1. Reset first to guarantee a clean slate
      setLastMessage("Resetting previous simulation state...");
      await resetSimulation();
      await delay(1000);

      // 2. Provision Agents
      setLastMessage("Step 1/6: Provisioning virtual agents...");
      const agentsRes = await provisionAgents();
      if (agentsRes.data?.driver?.userId) {
        driverUserIdRef.current = agentsRes.data.driver.userId;
      }
      await refreshJourney();
      await delay(1500);

      // 3. Create Bookings
      setLastMessage("Step 2/6: Creating shared bookings at PDEU Demo Station...");
      await createDemoBookings();
      await refreshJourney();
      await delay(1500);

      // 4. Trigger Matching & Dispatch
      setLastMessage("Step 3/6: Executing matching engine at PDEU Demo Station...");
      await triggerMatching("PDEU Demo Station");
      await refreshJourney();
      await delay(2000);

      // 5. Driver Accepts Offer
      setLastMessage("Step 4/6: Driver Ramesh accepts dispatch offer...");
      await progressStep();
      await refreshJourney();
      await delay(1500);

      // 6. Driver Arrives at Hub
      setLastMessage("Step 5/6: Driver arrives at PDEU Demo Station...");
      await progressStep();
      await refreshJourney();
      await delay(1500);

      // 7. Verify Boarding (OTPs) & Start Trip
      setLastMessage("Step 6/6: Verifying OTPs & departing PDEU Demo Station...");
      await progressStep();
      const updatedJourneyRes = await getActiveJourney();
      const activeJourney = updatedJourneyRes.data || journey;
      await refreshJourney();
      await delay(2000);

      // 8. GPS movement & Drop-offs dynamically derived from backend route geometry
      const waypoints = getRouteWaypoints(activeJourney?.route?.geometry);
      if (waypoints.length === 0) {
        setLastMessage(
          "Auto-run halted: Backend route geometry is unavailable or invalid. Cannot simulate driver GPS movement."
        );
        return;
      }
      const midPoint = Math.max(1, Math.floor(waypoints.length / 2));

      // Leg 1: Travel towards first drop-off
      for (let i = 0; i < midPoint; i++) {
        const pt = waypoints[i];
        if (driverUserIdRef.current) {
          await updateDriverLocation(driverUserIdRef.current, pt.lat, pt.lng);
        }
        await delay(1000);
      }

      // First Drop-off (Autoritative destination name)
      const p1DestName =
        activeJourney?.passengers?.[0]?.destination?.name ||
        "First Passenger Destination";
      setLastMessage(`Drop-off Commuter A at ${p1DestName}...`);
      await progressStep();
      await refreshJourney();
      await delay(1500);

      // Leg 2: Travel towards second drop-off
      for (let i = midPoint; i < waypoints.length; i++) {
        const pt = waypoints[i];
        if (driverUserIdRef.current) {
          await updateDriverLocation(driverUserIdRef.current, pt.lat, pt.lng);
        }
        await delay(1000);
      }

      // Second Drop-off (Authoritative destination name)
      const p2DestName =
        activeJourney?.passengers?.[1]?.destination?.name ||
        "Second Passenger Destination";
      setLastMessage(`Drop-off Commuter B at ${p2DestName}...`);
      await progressStep();
      await refreshJourney();
      await delay(1500);

      // Complete Trip
      setLastMessage("All passengers dropped off. Completing trip...");
      await progressStep();
      await refreshJourney();
      setLastMessage(
        "Auto-run completed successfully! Full journey lifecycle demonstrated."
      );
    } catch (err: any) {
      setLastMessage(`Auto-run error: ${err.message}`);
    } finally {
      setAutoRunning(false);
      setLoading(false);
    }
  };

  const handleReset = async () => {
    try {
      setResetting(true);
      await resetSimulation();
      waypointIndexRef.current = 0;
      setLastMessage("Simulation state reset cleanly in database.");
      addEvent("simulation.reset", { success: true });
      await refreshJourney();
    } catch (err: any) {
      setLastMessage(`Error resetting: ${err.message}`);
    } finally {
      setResetting(false);
    }
  };

  const isRouteAvailable =
    getRouteWaypoints(journey?.route?.geometry).length > 0;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <Header
        socketConnected={socketConnected}
        adminEmail={adminUser?.email || null}
        onReset={handleReset}
        resetting={resetting}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* Controls Panel */}
        <SimulationControls
          onProvisionAgents={handleProvisionAgents}
          onCreateBookings={handleCreateBookings}
          onTriggerMatching={handleTriggerMatching}
          onProgressStep={handleProgressStep}
          onSimulateGps={handleSimulateGps}
          onAutoRun={handleAutoRun}
          loading={loading}
          autoRunning={autoRunning}
          lastMessage={lastMessage}
          journeyState={journey?.journeyState || "IDLE"}
          isRouteAvailable={isRouteAvailable}
        />

        {/* Status Card */}
        <JourneyStatusCard journey={journey} loading={loading} />

        {/* Map & Realtime Event Feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <LiveMap
              driverGps={driverGps}
              routeGeometry={journey?.route?.geometry}
              passengers={journey?.passengers}
            />
          </div>

          <div className="lg:col-span-1">
            <EventTimeline events={events} onClear={() => setEvents([])} />
          </div>
        </div>
      </main>
    </div>
  );
}
