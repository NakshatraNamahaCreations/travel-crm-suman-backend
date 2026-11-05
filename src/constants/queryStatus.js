// Pipeline stages — order + labels mirror the Trips sidebar tabs.
export const QUERY_STATUSES = [
  { value: 'new_query', label: 'New Query' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'converted', label: 'Converted' },
  { value: 'on_trip', label: 'On Trip' },
  { value: 'past', label: 'Past Trips' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'dropped', label: 'Dropped' },
];

export const QUERY_STATUS_VALUES = QUERY_STATUSES.map((s) => s.value);

// Stages a query is considered "open/active" in (used for default list + counts).
export const ACTIVE_STATUSES = ['new_query', 'in_progress'];
