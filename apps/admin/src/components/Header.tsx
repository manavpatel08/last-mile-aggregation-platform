"use client";

import React from "react";
import { Activity, Shield, RefreshCw, Radio } from "lucide-react";

interface HeaderProps {
  socketConnected: boolean;
  adminEmail: string | null;
  onReset: () => void;
  resetting: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  socketConnected,
  adminEmail,
  onReset,
  resetting,
}) => {
  return (
    <header className="bg-white border-b border-slate-200 px-6 py-4 flex flex-wrap items-center justify-between shadow-sm">
      <div className="flex items-center space-x-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-indigo-200 shadow-md">
          <Activity className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            Last-Mile Simulation Control Center
          </h1>
          <p className="text-xs text-slate-500">
            PDEU Demo Station · Stage 11 Demo
          </p>
        </div>
      </div>

      <div className="flex items-center space-x-4 mt-2 sm:mt-0">
        {/* Socket Status */}
        <div
          className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-semibold ${
            socketConnected
              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
              : "bg-amber-50 text-amber-700 border border-amber-200"
          }`}
        >
          <Radio
            className={`w-3.5 h-3.5 ${
              socketConnected ? "animate-pulse text-emerald-600" : ""
            }`}
          />
          <span>{socketConnected ? "Realtime Live" : "Connecting..."}</span>
        </div>

        {/* Admin Badge */}
        {adminEmail && (
          <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200 text-xs font-medium">
            <Shield className="w-3.5 h-3.5 text-indigo-600" />
            <span>{adminEmail}</span>
          </div>
        )}

        {/* Reset Button */}
        <button
          onClick={onReset}
          disabled={resetting}
          className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-semibold transition disabled:opacity-50"
          title="Safely purge active simulation data"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${resetting ? "animate-spin" : ""}`} />
          <span>{resetting ? "Resetting..." : "Reset Simulation"}</span>
        </button>
      </div>
    </header>
  );
};
