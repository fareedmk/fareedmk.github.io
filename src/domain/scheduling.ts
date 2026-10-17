import { integer } from "./money";
import { DomainError } from "./types";

export interface BusinessHours {
  /** Sunday = 0, Saturday = 6. Overnight hours belong to the opening day. */
  day: number;
  open: string;
  close: string;
}

export interface PickupSlotOptions {
  now: string | number | Date;
  timeZone: string;
  leadMinutes: number;
  intervalMinutes: number;
  capacity: number;
  hours: BusinessHours[];
  /** Number of local calendar dates including today; defaults to 7, maximum 31. */
  daysAhead?: number;
  reservations?: { startsAt: string; quantity: number }[];
  /** Local YYYY-MM-DD closures. */
  closedDates?: string[];
}

export interface PickupSlot {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly remainingCapacity: number;
}

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

function instant(value: string | number | Date): number {
  if (typeof value === "string" && !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new DomainError("INVALID_DATE", "Timestamps must include a UTC offset");
  }
  const result = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime())) {
    throw new DomainError("INVALID_DATE", "Invalid timestamp");
  }
  return result;
}

function clock(value: string, close = false): number {
  if (close && value === "24:00") return 1440;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new DomainError("INVALID_HOURS", "Hours must use HH:mm");
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

/**
 * Enumerates actual UTC instants, then checks local business hours using Intl.
 * Nonexistent spring-forward times never occur; repeated fall-back times are
 * separate UTC slots with independent capacity. Intervals anchor to local opening.
 */
export function pickupSlots(options: PickupSlotOptions): readonly PickupSlot[] {
  const now = instant(options.now);
  integer(options.leadMinutes, "leadMinutes");
  integer(options.intervalMinutes, "intervalMinutes", 1);
  integer(options.capacity, "capacity");
  const daysAhead = integer(options.daysAhead ?? 7, "daysAhead", 1);
  if (daysAhead > 31 || options.leadMinutes > 31 * 1440 || options.intervalMinutes > 1440) {
    throw new DomainError("INVALID_SCHEDULE", "Schedule range exceeds 31 days or interval exceeds one day");
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch {
    throw new DomainError("INVALID_TIME_ZONE", "Unknown IANA time zone");
  }
  const local = (at: number) => {
    const parts = format.formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
    const year = part("year"), month = part("month"), day = part("day");
    const date = `${year}-${month}-${day}`;
    const midnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return {
      date, midnight,
      day: new Date(midnight).getUTCDay(),
      minute: Number(part("hour")) * 60 + Number(part("minute")),
    };
  };
  const hours = options.hours.map((entry) => {
    integer(entry.day, "hours.day");
    if (entry.day > 6) throw new DomainError("INVALID_HOURS", "Weekday must be 0–6");
    const open = clock(entry.open), rawClose = clock(entry.close, true);
    if (open === rawClose) throw new DomainError("INVALID_HOURS", "Opening and closing times must differ");
    return { day: entry.day, open, close: rawClose < open ? rawClose + 1440 : rawClose };
  });
  const closed = new Set(options.closedDates ?? []);
  for (const date of closed) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new DomainError("INVALID_DATE", "Closure dates must be valid YYYY-MM-DD dates");
    }
  }
  const reservations = new Map<number, number>();
  for (const reservation of options.reservations ?? []) {
    const at = instant(reservation.startsAt);
    integer(reservation.quantity, "reservation.quantity", 1);
    const count = (reservations.get(at) ?? 0) + reservation.quantity;
    integer(count, "reserved capacity");
    reservations.set(at, count);
  }
  const today = local(now).midnight;
  const earliest = Math.ceil((now + options.leadMinutes * MINUTE) / MINUTE) * MINUTE;
  const end = now + (daysAhead + 2) * DAY;
  instant(end);
  const slots: PickupSlot[] = [];
  for (let at = earliest; at < end; at += MINUTE) {
    const current = local(at);
    const dayOffset = (current.midnight - today) / DAY;
    if (dayOffset >= daysAhead) break;
    if (dayOffset < 0 || closed.has(current.date)) continue;
    const previousDate = new Date(current.midnight - DAY).toISOString().slice(0, 10);
    const isOpen = hours.some((entry) => {
      let relative: number;
      if (entry.day === current.day) relative = current.minute;
      else if (entry.close > 1440 && entry.day === (current.day + 6) % 7 && !closed.has(previousDate)) {
        relative = current.minute + 1440;
      } else return false;
      return relative >= entry.open && relative < entry.close &&
        (relative - entry.open) % options.intervalMinutes === 0;
    });
    if (!isOpen) continue;
    const remainingCapacity = Math.max(0, options.capacity - (reservations.get(at) ?? 0));
    if (remainingCapacity === 0) continue;
    slots.push(Object.freeze({
      startsAt: new Date(at).toISOString(),
      endsAt: new Date(at + options.intervalMinutes * MINUTE).toISOString(),
      remainingCapacity,
    }));
  }
  return Object.freeze(slots);
}
