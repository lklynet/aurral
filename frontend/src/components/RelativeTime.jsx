import { useEffect, useState } from "react";
import Tooltip from "./Tooltip";
import {
  formatDate,
  formatDateTime,
  formatRelativeTime,
  nextRelativeTimeChange,
} from "../utils/dateTime.js";

const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const dateOnly = typeof value === "string" ? value.match(/^\d{4}-\d{2}-\d{2}$/)?.[0] : null;
  const date = new Date(dateOnly ? `${dateOnly}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export default function RelativeTime({ value, unit, className }) {
  const date = toDate(value);
  const time = date ? date.getTime() : null;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (time === null) return undefined;
    const timeout = window.setTimeout(
      () => setTick((current) => current + 1),
      nextRelativeTimeChange(new Date(time), { unit }),
    );
    return () => window.clearTimeout(timeout);
  }, [tick, time, unit]);

  if (!date) return null;
  const absolute =
    unit === "day"
      ? formatDate(date, { year: "numeric", month: "long", day: "numeric" })
      : formatDateTime(date, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <Tooltip content={absolute}>
      <time className={className} dateTime={date.toISOString()}>
        {formatRelativeTime(date, { unit })}
      </time>
    </Tooltip>
  );
}
