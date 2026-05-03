// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// fmtTime: always "HH:MM" — for message timestamps
export function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// fmtAge: "3:45 PM" same day, "Mon" this week, "Jan 5" older — for session list
export function fmtAge(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 86_400_000)   return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 7*86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// relativeTime: "5m ago", "3h ago", "2d ago", or "Jan 5"
export function relativeTime(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH   = Math.floor(diffMs / 3_600_000);
  const diffD   = Math.floor(diffMs / 86_400_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffH   < 24) return `${diffH}h ago`;
  if (diffD   <  7) return `${diffD}d ago`;
  return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
