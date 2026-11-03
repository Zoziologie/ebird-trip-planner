import { tripTimeZone } from './tripTimeZone.js';

export const tripDates = (stops, timeZone, now = new Date()) => {
  const dated = stops
    .filter((stop) => stop.dateTime)
    .sort((a, b) => a.dateTime.localeCompare(b.dateTime));
  if (!dated.length) return { group: 'undated', label: 'No dates yet' };
  const first = dated[0],
    start = first.dateTime.slice(0, 10),
    end = dated.at(-1).dateTime.slice(0, 10),
    today = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tripTimeZone(timeZone, first.latitude, first.longitude),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now),
    format = (date) =>
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${date}T00:00:00Z`));
  return {
    group: today < start ? 'upcoming' : today > end ? 'past' : 'current',
    label: start === end ? format(start) : `${format(start)} – ${format(end)}`,
  };
};
