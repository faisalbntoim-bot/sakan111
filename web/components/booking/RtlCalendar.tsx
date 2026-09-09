'use client';

/**
 * Arabic RTL calendar with Saturday as the first weekday.
 *
 * Behaviour:
 *  - First click picks the check-in date.
 *  - Second click, if AFTER the first, picks the check-out date.
 *  - Second click, if BEFORE the first, resets: it becomes the new check-in.
 *  - Days before today are disabled (past bookings make no sense).
 *  - Days in `bookedDays` (day-of-month numbers for the visible month) are
 *    disabled to match the SPA's `booked` array on each property record.
 *  - Prev/next month arrows navigate; the user can't go before the current
 *    month.
 */

import { useMemo, useState } from 'react';
import { nfA } from '@/lib/booking-state';

const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
// Weekday order for RTL Arabic calendars starts on Saturday.
const AR_WEEKDAYS = ['السبت','الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة'];
// JS Date.getDay(): 0=Sunday..6=Saturday. Column for a given getDay() so
// that Saturday sits in the first (right-most in RTL) column:
//   getDay: 6=Sat→col 0, 0=Sun→1, 1=Mon→2, 2=Tue→3, 3=Wed→4, 4=Thu→5, 5=Fri→6
const COL_FOR_GETDAY = [1, 2, 3, 4, 5, 6, 0];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

type Props = {
  bookedDays: number[]; // day-of-month numbers to disable in the CURRENT visible month
  checkIn: string | null;
  checkOut: string | null;
  onChange: (checkIn: string | null, checkOut: string | null) => void;
};

export function RtlCalendar({ bookedDays, checkIn, checkOut, onChange }: Props) {
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  const [view, setView] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const year = view.getFullYear();
  const month = view.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const leadingPad = COL_FOR_GETDAY[firstOfMonth.getDay()] ?? 0;

  const isCurrentMonthView =
    year === today.getFullYear() && month === today.getMonth();

  const goPrev = () => {
    if (isCurrentMonthView) return;
    setView(new Date(year, month - 1, 1));
  };
  const goNext = () => setView(new Date(year, month + 1, 1));

  const handleClick = (day: number) => {
    const clicked = ymd(new Date(year, month, day));
    if (!checkIn || (checkIn && checkOut)) {
      onChange(clicked, null);
      return;
    }
    // A check-in already exists, no check-out yet.
    if (clicked <= checkIn) {
      // Reset to a new check-in if the user picks an earlier or same day.
      onChange(clicked, null);
    } else {
      onChange(checkIn, clicked);
    }
  };

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < leadingPad; i++) {
    cells.push(<div key={`pad-${i}`} className="rcal-day pad" />);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(year, month, d);
    const cellYmd = ymd(cellDate);
    const isPast = cellDate < today;
    // Only apply the booked-days filter for the current visible month.
    // The property's `booked` numbers are month-agnostic in the SPA, so
    // we mirror that behaviour rather than inventing multi-month data.
    const isBooked = isCurrentMonthView && bookedDays.includes(d);
    const isDisabled = isPast || isBooked;
    const isSel = cellYmd === checkIn || cellYmd === checkOut;
    const isInRange =
      !!(checkIn && checkOut && cellYmd > checkIn && cellYmd < checkOut);
    const cls = [
      'rcal-day',
      isDisabled ? 'disabled' : '',
      isSel ? 'sel' : '',
      isInRange ? 'range' : '',
    ].filter(Boolean).join(' ');
    cells.push(
      <button
        key={`d-${d}`}
        type="button"
        className={cls}
        disabled={isDisabled}
        onClick={() => handleClick(d)}
        aria-label={`${d} ${AR_MONTHS[month]}`}
      >
        {nfA(d)}
      </button>
    );
  }

  return (
    <div className="rcal">
      <div className="rcal-head">
        <button
          type="button"
          className="rcal-nav"
          onClick={goPrev}
          disabled={isCurrentMonthView}
          aria-label="الشهر السابق"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <div className="rcal-title">{AR_MONTHS[month]} {nfA(year)}</div>
        <button
          type="button"
          className="rcal-nav"
          onClick={goNext}
          aria-label="الشهر التالي"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>
      <div className="rcal-weekdays">
        {AR_WEEKDAYS.map(w => <div key={w} className="rcal-wd">{w}</div>)}
      </div>
      <div className="rcal-grid">{cells}</div>
    </div>
  );
}
