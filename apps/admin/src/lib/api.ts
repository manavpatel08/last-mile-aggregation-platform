import { io, Socket } from "socket.io-client";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000/api/v1";
export const SOCKET_BASE =
  process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3000";

let adminToken: string | null = null;
let activeSocket: Socket | null = null;

export function setToken(token: string) {
  adminToken = token;
  if (typeof window !== "undefined") {
    localStorage.setItem("lastmile_admin_token", token);
  }
}

export function getToken(): string | null {
  if (adminToken) return adminToken;
  if (typeof window !== "undefined") {
    adminToken = localStorage.getItem("lastmile_admin_token");
  }
  return adminToken;
}

export async function adminLogin(): Promise<{ accessToken: string; user: any }> {
  const res = await fetch(`${API_BASE}/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idToken:
        "demo-google-token:admin-google-sub-001:admin@pdeu.ac.in:Platform Administrator",
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.data?.accessToken) {
    throw new Error(json.message || "Failed to authenticate as Admin");
  }

  setToken(json.data.accessToken);
  return json.data;
}

export async function apiRequest(path: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Request failed with status ${res.status}`);
  }
  return data;
}

export async function provisionAgents() {
  return apiRequest("/admin/simulation/provision-agents", { method: "POST" });
}

export async function createDemoBookings() {
  return apiRequest("/admin/simulation/create-bookings", { method: "POST" });
}

export async function triggerMatching(pickupPointName: string = "PDEU Demo Station") {
  return apiRequest("/admin/simulation/trigger-matching", {
    method: "POST",
    body: JSON.stringify({ pickupPointName }),
  });
}

export async function getActiveJourney() {
  return apiRequest("/admin/simulation/active-journey", { method: "GET" });
}

export async function progressStep() {
  return apiRequest("/admin/simulation/progress-step", { method: "POST" });
}

export async function updateDriverLocation(
  driverUserId: string,
  latitude: number,
  longitude: number
) {
  return apiRequest("/admin/simulation/location", {
    method: "POST",
    body: JSON.stringify({ driverUserId, latitude, longitude }),
  });
}

export async function resetSimulation() {
  return apiRequest("/admin/simulation/reset", { method: "POST" });
}

export async function connectAdminSocket(
  onEvent: (event: { name: string; data: any; time: string }) => void
): Promise<Socket> {
  if (activeSocket?.connected) {
    return activeSocket;
  }

  // 1. Get single-use socket ticket
  const ticketRes = await apiRequest("/auth/socket-ticket");
  const ticket = ticketRes.data?.ticket;

  if (!ticket) {
    throw new Error("Failed to obtain socket ticket from backend");
  }

  // 2. Connect to /realtime namespace
  const socket = io(`${SOCKET_BASE}/realtime`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { ticket },
  });

  socket.on("connect", () => {
    onEvent({
      name: "connected",
      data: { socketId: socket.id, room: "admin" },
      time: new Date().toLocaleTimeString(),
    });
  });

  // Listen to all canonical admin broadcasts
  const events = [
    "driver.location.updated",
    "group.updated",
    "trip.status.updated",
    "trip.interrupted",
    "trip.resumed",
    "trip.aborted",
    "booking.created",
    "booking.status.updated",
    "payment.confirmed",
  ];

  for (const evt of events) {
    socket.on(evt, (payload) => {
      onEvent({
        name: evt,
        data: payload,
        time: new Date().toLocaleTimeString(),
      });
    });
  }

  activeSocket = socket;
  return socket;
}
