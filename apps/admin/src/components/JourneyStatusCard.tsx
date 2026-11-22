"use client";

import React from "react";
import {
  Car,
  Users,
  MapPin,
  KeyRound,
  CheckCircle2,
  Clock,
  Navigation,
} from "lucide-react";

interface JourneyStatusCardProps {
  journey: any | null;
  loading: boolean;
}

export const JourneyStatusCard: React.FC<JourneyStatusCardProps> = ({
  journey,
  loading,
}) => {
  const journeyState = journey?.journeyState || "IDLE";

  const getStatusBadge = (state: string) => {
    switch (state) {
      case "IDLE":
        return "bg-slate-100 text-slate-700 border-slate-200";
      case "WAITING_FOR_MATCH":
        return "bg-sky-50 text-sky-700 border-sky-200 animate-pulse";
      case "DISPATCHING":
        return "bg-amber-50 text-amber-700 border-amber-200 animate-pulse";
      case "ASSIGNED":
        return "bg-indigo-50 text-indigo-700 border-indigo-200";
      case "AT_PICKUP":
        return "bg-cyan-50 text-cyan-700 border-cyan-200";
      case "IN_PROGRESS":
        return "bg-emerald-50 text-emerald-700 border-emerald-200 font-bold";
      case "COMPLETED":
        return "bg-green-50 text-green-700 border-green-200 font-bold";
      default:
        return "bg-slate-100 text-slate-700 border-slate-200";
    }
  };

  const getPassengerStatusBadge = (status: string) => {
    switch (status) {
      case "WAITING":
        return "bg-amber-100 text-amber-800";
      case "BOARDED":
        return "bg-indigo-100 text-indigo-800 font-semibold";
      case "COMPLETED":
        return "bg-emerald-100 text-emerald-800 font-semibold";
      default:
        return "bg-slate-100 text-slate-800";
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-6">
      {/* Top Bar: Journey State */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
        <div>
          <span className="text-xs uppercase tracking-wider font-semibold text-slate-500">
            Authoritative Journey Status
          </span>
          <div className="flex items-center space-x-3 mt-1">
            <span
              className={`px-3 py-1 rounded-full text-xs font-semibold border ${getStatusBadge(
                journeyState
              )}`}
            >
              {journeyState}
            </span>
            {journey?.trip?.id && (
              <span className="text-xs text-slate-500">
                Trip ID:{" "}
                <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 font-mono">
                  {journey.trip.id.slice(0, 8)}...
                </code>
              </span>
            )}
            {journey?.rideGroup?.id && !journey?.trip?.id && (
              <span className="text-xs text-slate-500">
                Group ID:{" "}
                <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700 font-mono">
                  {journey.rideGroup.id.slice(0, 8)}...
                </code>
              </span>
            )}
          </div>
        </div>

        {/* Route Stats */}
        {journey?.route && (
          <div className="flex items-center space-x-4 text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-xl border border-slate-200">
            <div className="flex items-center space-x-1">
              <Navigation className="w-3.5 h-3.5 text-indigo-600" />
              <span>
                Distance:{" "}
                <strong>
                  {(journey.route.distanceMeters / 1000).toFixed(1)} km
                </strong>
              </span>
            </div>
            <div className="flex items-center space-x-1">
              <Clock className="w-3.5 h-3.5 text-indigo-600" />
              <span>
                Est. Duration:{" "}
                <strong>
                  {Math.round(journey.route.durationSec / 60)} mins
                </strong>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Grid: Driver & Vehicle Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Driver Card */}
        <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
          <div className="flex items-center space-x-2 text-slate-900 font-semibold text-sm mb-3">
            <Car className="w-4 h-4 text-indigo-600" />
            <span>Assigned Micro-Mobility Driver</span>
          </div>

          {journey?.driver ? (
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Driver Name:</span>
                <strong className="text-slate-800">
                  {journey.driver.fullName}
                </strong>
              </div>
              <div className="flex justify-between">
                <span>Vehicle:</span>
                <strong className="text-slate-800">
                  {journey.driver.vehicle}
                </strong>
              </div>
              <div className="flex justify-between">
                <span>License:</span>
                <span className="font-mono text-slate-800">
                  {journey.driver.licenseNumber}
                </span>
              </div>
              {journey.driver.currentGps && (
                <div className="flex justify-between pt-1 border-t border-slate-200">
                  <span>GPS Fix:</span>
                  <span className="font-mono text-emerald-600">
                    {journey.driver.currentGps.latitude.toFixed(4)},{" "}
                    {journey.driver.currentGps.longitude.toFixed(4)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500 italic">
              {journeyState === "DISPATCHING"
                ? "Dispatch offer pending with Driver Ramesh..."
                : "No driver assigned yet. Click 'Run Matching Engine'."}
            </p>
          )}
        </div>

        {/* Dispatch & Group Details */}
        <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
          <div className="flex items-center space-x-2 text-slate-900 font-semibold text-sm mb-3">
            <Users className="w-4 h-4 text-indigo-600" />
            <span>Shared Pooling Status</span>
          </div>

          {journeyState === "IDLE" && (
            <p className="text-xs text-slate-500 italic">
              Simulation environment is idle. Ready to prepare demo agents.
            </p>
          )}

          {journeyState === "WAITING_FOR_MATCH" && (
            <div className="text-xs space-y-1.5 text-slate-600">
              <p className="text-amber-700 font-medium">
                {journey.bookings?.length || 0} booking(s) waiting in matching pool
              </p>
              <p className="text-slate-500">
                Click &quot;Run Matching Engine&quot; to form a shared ride group.
              </p>
            </div>
          )}

          {journeyState === "DISPATCHING" && journey?.rideGroup && (
            <div className="text-xs space-y-2 text-slate-600">
              <p className="font-medium text-amber-700">
                Ride group formed! Single-offer dispatch in progress.
              </p>
              {journey.rideGroup.pendingOffer && (
                <div className="bg-white p-2.5 rounded-lg border border-amber-200 space-y-1">
                  <div className="flex justify-between">
                    <span>Target Driver:</span>
                    <strong className="text-slate-900">
                      {journey.rideGroup.pendingOffer.driverName}
                    </strong>
                  </div>
                  <div className="flex justify-between text-slate-500 text-[11px]">
                    <span>20-Second Timeout:</span>
                    <span>Active</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {(journeyState === "ASSIGNED" ||
            journeyState === "AT_PICKUP" ||
            journeyState === "IN_PROGRESS" ||
            journeyState === "COMPLETED") && (
            <div className="text-xs space-y-1.5 text-slate-600">
              <div className="flex items-center space-x-1.5 text-emerald-700 font-medium">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>Group Confirmed & Dispatched</span>
              </div>
              <p className="text-slate-500">
                Passengers pooled along Gandhinagar corridor.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Passenger Manifest Table */}
      {journey?.passengers && journey.passengers.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center space-x-2">
              <Users className="w-4 h-4 text-indigo-600" />
              <span>Pooled Passenger Manifest</span>
            </h3>
            <span className="text-xs text-slate-500">
              {journey.passengers.length} commuter(s) pooled
            </span>
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3">Commuter Name</th>
                  <th className="px-4 py-3">Drop-off Hub</th>
                  <th className="px-4 py-3">Boarding OTP</th>
                  <th className="px-4 py-3">Pooled Fare</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {journey.passengers.map((p: any) => (
                  <tr key={p.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      {p.fullName}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {p.destination?.name ||
                        (p.destination?.latitude && p.destination?.longitude
                          ? `${p.destination.latitude.toFixed(4)}, ${p.destination.longitude.toFixed(4)}`
                          : "Drop-off Destination")}
                    </td>
                    <td className="px-4 py-3">
                      {p.boardingOtp ? (
                        <span className="inline-flex items-center space-x-1 bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded font-mono font-bold text-xs">
                          <KeyRound className="w-3 h-3 text-amber-600" />
                          <span>{p.boardingOtp}</span>
                        </span>
                      ) : (
                        <span className="text-slate-400 font-mono">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-900">
                      ₹{(p.finalRideFarePaise / 100).toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] ${getPassengerStatusBadge(
                          p.status
                        )}`}
                      >
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
