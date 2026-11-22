"use client";

import React, { useState } from "react";
import { Radio, Trash2, ChevronDown, ChevronRight } from "lucide-react";

export interface SocketEventLog {
  id: string;
  name: string;
  time: string;
  data: any;
}

interface EventTimelineProps {
  events: SocketEventLog[];
  onClear: () => void;
}

export const EventTimeline: React.FC<EventTimelineProps> = ({
  events,
  onClear,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const getEventBadgeColor = (name: string) => {
    if (name.includes("location")) {
      return "bg-amber-50 text-amber-700 border-amber-200";
    }
    if (name.includes("trip")) {
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    }
    if (name.includes("group")) {
      return "bg-indigo-50 text-indigo-700 border-indigo-200";
    }
    if (name.includes("payment")) {
      return "bg-green-50 text-green-700 border-green-200";
    }
    return "bg-slate-100 text-slate-700 border-slate-200";
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <div className="flex items-center space-x-2">
          <Radio className="w-4 h-4 text-indigo-600 animate-pulse" />
          <h3 className="text-sm font-semibold text-slate-900">
            Realtime WebSocket Events (/realtime)
          </h3>
          <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full text-[11px] font-mono">
            {events.length}
          </span>
        </div>

        {events.length > 0 && (
          <button
            onClick={onClear}
            className="text-xs text-slate-500 hover:text-slate-800 flex items-center space-x-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      <div className="max-h-[380px] overflow-y-auto space-y-2 pr-1">
        {events.length === 0 ? (
          <p className="text-xs text-slate-400 italic py-6 text-center">
            No realtime events received yet. Realtime events appear here as
            simulation progresses.
          </p>
        ) : (
          events.map((evt) => (
            <div
              key={evt.id}
              className="p-3 bg-slate-50 hover:bg-slate-100/80 rounded-xl border border-slate-200 text-xs transition"
            >
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => toggleExpand(evt.id)}
              >
                <div className="flex items-center space-x-2">
                  <span
                    className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${getEventBadgeColor(
                      evt.name
                    )}`}
                  >
                    {evt.name}
                  </span>
                  <span className="text-slate-400 font-mono text-[11px]">
                    {evt.time}
                  </span>
                </div>
                {expandedId === evt.id ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                )}
              </div>

              {expandedId === evt.id && (
                <pre className="mt-2 p-2 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto">
                  {JSON.stringify(evt.data, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
