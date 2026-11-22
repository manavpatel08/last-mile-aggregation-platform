"use client";

import React from "react";
import {
  Users,
  Ticket,
  Cpu,
  StepForward,
  Navigation,
  Play,
  CheckCircle,
  AlertCircle,
  Loader2,
} from "lucide-react";

interface SimulationControlsProps {
  onProvisionAgents: () => Promise<void>;
  onCreateBookings: () => Promise<void>;
  onTriggerMatching: () => Promise<void>;
  onProgressStep: () => Promise<void>;
  onSimulateGps: () => Promise<void>;
  onAutoRun: () => Promise<void>;
  loading: boolean;
  autoRunning: boolean;
  lastMessage: string | null;
  journeyState: string;
}

export const SimulationControls: React.FC<SimulationControlsProps> = ({
  onProvisionAgents,
  onCreateBookings,
  onTriggerMatching,
  onProgressStep,
  onSimulateGps,
  onAutoRun,
  loading,
  autoRunning,
  lastMessage,
  journeyState,
}) => {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-5">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">
            Interactive Simulation Controls
          </h2>
          <p className="text-xs text-slate-500">
            Drive authoritative backend lifecycle transitions against NestJS
          </p>
        </div>

        {/* Auto Run Button */}
        <button
          onClick={onAutoRun}
          disabled={loading || autoRunning}
          className="flex items-center space-x-1.5 px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white rounded-xl text-xs font-semibold shadow-md shadow-indigo-100 transition disabled:opacity-50"
        >
          {autoRunning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5 fill-current" />
          )}
          <span>{autoRunning ? "Auto Journey Running..." : "Auto Run Full Journey"}</span>
        </button>
      </div>

      {/* Action Buttons Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Step 1: Provision Agents */}
        <button
          onClick={onProvisionAgents}
          disabled={loading || autoRunning}
          className="flex flex-col items-start p-3.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 hover:border-slate-300 text-left transition disabled:opacity-50 group"
        >
          <div className="flex items-center space-x-2 text-indigo-600 mb-1.5">
            <Users className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
              1. Setup Agents
            </span>
          </div>
          <span className="text-[11px] text-slate-500 leading-snug">
            Provision 2 virtual passengers & 1 approved driver (Ramesh)
          </span>
        </button>

        {/* Step 2: Create Bookings */}
        <button
          onClick={onCreateBookings}
          disabled={loading || autoRunning}
          className="flex flex-col items-start p-3.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 hover:border-slate-300 text-left transition disabled:opacity-50 group"
        >
          <div className="flex items-center space-x-2 text-indigo-600 mb-1.5">
            <Ticket className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
              2. Book Rides
            </span>
          </div>
          <span className="text-[11px] text-slate-500 leading-snug">
            Request 2 shared corridor bookings from PDEU Main Gate
          </span>
        </button>

        {/* Step 3: Trigger Matching */}
        <button
          onClick={onTriggerMatching}
          disabled={loading || autoRunning}
          className="flex flex-col items-start p-3.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 hover:border-slate-300 text-left transition disabled:opacity-50 group"
        >
          <div className="flex items-center space-x-2 text-indigo-600 mb-1.5">
            <Cpu className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-wider text-slate-900">
              3. Match Engine
            </span>
          </div>
          <span className="text-[11px] text-slate-500 leading-snug">
            Run batch matching cycle, build route version & offer to driver
          </span>
        </button>

        {/* Step 4: Step Journey */}
        <button
          onClick={onProgressStep}
          disabled={loading || autoRunning || journeyState === "IDLE"}
          className="flex flex-col items-start p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100 hover:border-emerald-300 text-left transition disabled:opacity-50 group"
        >
          <div className="flex items-center space-x-2 text-emerald-700 mb-1.5">
            <StepForward className="w-4 h-4" />
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-900">
              4. Step Lifecycle
            </span>
          </div>
          <span className="text-[11px] text-emerald-800 leading-snug">
            Advance state: Accept &rarr; Arrive &rarr; Board OTP &rarr; Drop-off &rarr; Complete
          </span>
        </button>
      </div>

      {/* Extra Simulation Controls */}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
        <button
          onClick={onSimulateGps}
          disabled={loading || autoRunning || (journeyState !== "IN_PROGRESS" && journeyState !== "AT_PICKUP" && journeyState !== "ASSIGNED")}
          className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition disabled:opacity-50"
        >
          <Navigation className="w-3.5 h-3.5 text-indigo-600" />
          <span>Simulate Driver GPS Move</span>
        </button>
      </div>

      {/* Status Message Toast */}
      {lastMessage && (
        <div className="flex items-center space-x-2 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700">
          <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <span>{lastMessage}</span>
        </div>
      )}
    </div>
  );
};
