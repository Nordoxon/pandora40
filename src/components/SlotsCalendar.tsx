import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";

interface KortSlotRow {
  id: string;
  site_id: string;
  slot_key: string;
  slot_date: string; // YYYY-MM-DD
  start_time: string | null;
  end_time: string | null;
  court_name: string | null;
}

interface Props {
  siteId: string | null;
  lastCheckedAt?: string | null;
}

const RU_MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];
const RU_WEEKDAYS_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function buildMonthGrid(monthDate: Date): Date[] {
  // 6 weeks * 7 days, week starts on Monday
  const first = startOfMonth(monthDate);
  // jsDay: 0=Sun..6=Sat -> shift to Mon=0
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export function SlotsCalendar({ siteId, lastCheckedAt }: Props) {
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);
  const horizonEnd = useMemo(() => {
    const e = new Date(today);
    e.setDate(today.getDate() + 29); // 30-day window inclusive
    return e;
  }, [today]);

  const [monthDate, setMonthDate] = useState<Date>(startOfMonth(today));
  const [selected, setSelected] = useState<Date>(today);
  const [slots, setSlots] = useState<KortSlotRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!siteId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("kort_slots")
      .select("id,site_id,slot_key,slot_date,start_time,end_time,court_name")
      .eq("site_id", siteId)
      .order("slot_date", { ascending: true });
    if (!error && data) setSlots(data as KortSlotRow[]);
    setLoading(false);
  }

  // Debounce realtime reloads — when the season opens, hundreds of insert
  // events can arrive in a burst. Coalesce them into a single fetch.
  const reloadTimer = useRef<number | null>(null);
  useEffect(() => {
    load();
    if (!siteId) return;
    const scheduleReload = () => {
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
      }
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = null;
        load();
      }, 800);
    };
    const ch = supabase
      .channel(`kort-slots-${siteId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "kort_slots", filter: `site_id=eq.${siteId}` },
        scheduleReload,
      )
      .subscribe();
    return () => {
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = null;
      }
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  // Index slots by date
  const slotsByDate = useMemo(() => {
    const map = new Map<string, KortSlotRow[]>();
    for (const s of slots) {
      const arr = map.get(s.slot_date) ?? [];
      arr.push(s);
      map.set(s.slot_date, arr);
    }
    return map;
  }, [slots]);

  const grid = useMemo(() => buildMonthGrid(monthDate), [monthDate]);
  const monthTitle = `${RU_MONTHS[monthDate.getMonth()]} ${monthDate.getFullYear()}`;

  const selectedKey = ymd(selected);
  const selectedSlots = (slotsByDate.get(selectedKey) ?? []).slice().sort((a, b) =>
    (a.start_time ?? "").localeCompare(b.start_time ?? ""),
  );
  const slotsByCourt = useMemo(() => {
    const m = new Map<string, KortSlotRow[]>();
    for (const s of selectedSlots) {
      const k = s.court_name ?? "—";
      const arr = m.get(k) ?? [];
      arr.push(s);
      m.set(k, arr);
    }
    return m;
  }, [selectedSlots]);

  const totalFree = slots.length;

  // Bounds for navigation: don't allow leaving the 30-day window
  const canPrev = monthDate > startOfMonth(today);
  const canNext = monthDate < startOfMonth(horizonEnd);

  if (!siteId) {
    return (
      <Card className="p-8 text-center bg-card/40 border-dashed">
        <Trophy className="size-6 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">
          Запустите мониторинг — и здесь появится календарь свободных слотов на 30 дней вперёд.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header / controls */}
      <Card className="p-3 sm:p-4 bg-card/60 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}
              disabled={!canPrev}
              aria-label="Предыдущий месяц"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <div className="font-mono-display text-sm sm:text-base font-medium capitalize min-w-[130px] sm:min-w-[160px] text-center">
              {monthTitle}
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}
              disabled={!canNext}
              aria-label="Следующий месяц"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground font-mono-display">
            всего свободно: <span className="text-primary">{totalFree}</span>
          </div>
        </div>

        {/* Weekday header */}
        <div className="mt-4 grid grid-cols-7 gap-1 text-[11px] text-muted-foreground font-mono-display uppercase tracking-wider">
          {RU_WEEKDAYS_SHORT.map((d) => (
            <div key={d} className="text-center py-1">{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="mt-1 grid grid-cols-7 gap-0.5 sm:gap-1">
          {grid.map((d) => {
            const inMonth = d.getMonth() === monthDate.getMonth();
            const inHorizon = d >= today && d <= horizonEnd;
            const key = ymd(d);
            const dayCount = slotsByDate.get(key)?.length ?? 0;
            const isSelected = isSameDay(d, selected);
            const isToday = isSameDay(d, today);

            const free = dayCount > 0;
            const intensity =
              dayCount === 0 ? 0 :
              dayCount < 3 ? 1 :
              dayCount < 8 ? 2 : 3;

            const bg =
              !inHorizon
                ? "bg-transparent"
                : intensity === 0
                  ? "bg-clay/15"
                  : intensity === 1
                    ? "bg-primary/15"
                    : intensity === 2
                      ? "bg-primary/30"
                      : "bg-primary/55";

            const ring = isSelected
              ? "ring-2 ring-primary"
              : isToday
                ? "ring-1 ring-foreground/40"
                : "";

            return (
              <button
                type="button"
                key={key}
                disabled={!inHorizon}
                onClick={() => setSelected(d)}
                className={`relative aspect-square rounded-md p-1 sm:p-1.5 text-left transition-colors ${bg} ${ring} ${
                  inHorizon ? "hover:bg-primary/40 cursor-pointer" : "opacity-30 cursor-not-allowed"
                } ${!inMonth ? "opacity-50" : ""}`}
                aria-label={`${key}: ${dayCount} свободных слотов`}
              >
                <div className={`text-[11px] sm:text-xs font-mono-display ${free ? "text-foreground" : "text-muted-foreground"}`}>
                  {d.getDate()}
                </div>
                {inHorizon && (
                  <div className={`absolute bottom-0.5 right-1 sm:bottom-1 sm:right-1.5 text-[9px] sm:text-[10px] font-mono-display font-semibold ${
                    free ? "text-primary-foreground/90" : "text-muted-foreground/70"
                  }`}>
                    {free ? dayCount : "—"}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground font-mono-display">
          <div className="flex items-center gap-1.5">
            <span className="size-3 rounded-sm bg-clay/15" />
            занято / нет свободных
          </div>
          <div className="flex items-center gap-1.5">
            <span className="size-3 rounded-sm bg-primary/15" />
            1–2
          </div>
          <div className="flex items-center gap-1.5">
            <span className="size-3 rounded-sm bg-primary/30" />
            3–7
          </div>
          <div className="flex items-center gap-1.5">
            <span className="size-3 rounded-sm bg-primary/55" />
            8+
          </div>
        </div>
      </Card>

      {/* Selected day details */}
      <Card className="p-4 sm:p-5 bg-card/60 backdrop-blur">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="font-mono-display font-medium">
            {formatSelectedTitle(selected)}
          </h3>
          <span className="text-xs text-muted-foreground font-mono-display">
            свободно: <span className="text-primary">{selectedSlots.length}</span>
          </span>
        </div>

        {loading && slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : selectedSlots.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 p-5 text-center text-sm text-muted-foreground">
            На этот день свободных слотов нет — все корты заняты или недоступны.
          </div>
        ) : (
          <div className="space-y-3">
            {[...slotsByCourt.entries()].map(([court, list]) => (
              <div key={court} className="rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Trophy className="size-3.5 text-primary" />
                  <span className="font-mono-display text-sm">{court}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground font-mono-display">
                    {list.length}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((s) => {
                    const t = s.end_time ? `${s.start_time}–${s.end_time}` : (s.start_time ?? "—");
                    return (
                      <span
                        key={s.id}
                        className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-mono-display text-primary"
                      >
                        {t}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {lastCheckedAt && (
          <p className="mt-4 text-[11px] text-muted-foreground font-mono-display">
            данные актуальны на {new Date(lastCheckedAt).toLocaleString("ru-RU")}
          </p>
        )}
      </Card>
    </div>
  );
}

function formatSelectedTitle(d: Date) {
  const days = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]}, ${days[d.getDay()]}`;
}