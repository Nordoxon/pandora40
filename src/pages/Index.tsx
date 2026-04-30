import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KortConfigCard, type KortSite } from "@/components/KortConfigCard";
import { HistoryFeed, type HistoryEntry } from "@/components/HistoryFeed";
import { SlotsCalendar } from "@/components/SlotsCalendar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Bell, Send, Activity, Clock, CalendarDays, History, Settings, Lock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";

const Index = () => {
  const [site, setSite] = useState<KortSite | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    document.title = "kort40 watch — мониторинг свободных слотов на kort40.online";
    const meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    if (meta) {
      meta.content =
        "kort40 watch — отслеживайте появление свободных слотов на kort40.online на 30 дней вперёд с уведомлениями в Telegram.";
    }
  }, []);

  async function loadAll() {
    const [{ data: s }, { data: h }] = await Promise.all([
      supabase
        .from("watched_sites")
        .select("*")
        .eq("monitor_type", "kort40")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("change_history")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    const first = (s ?? [])[0] as KortSite | undefined;
    setSite(first ?? null);
    setHistory((h ?? []) as HistoryEntry[]);
  }

  useEffect(() => {
    loadAll();
    const ch = supabase
      .channel("kort40-watch")
      .on("postgres_changes", { event: "*", schema: "public", table: "watched_sites" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "change_history" }, loadAll)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  async function sendTest() {
    setTesting(true);
    try {
      const { error } = await supabase.functions.invoke("telegram-test", { body: {} });
      if (error) throw error;
      toast.success("Тестовое сообщение отправлено в общий чат");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setTesting(false);
    }
  }

  const slotsCount = site?.current_hash?.startsWith("slots:")
    ? Number(site.current_hash.slice(6)) || 0
    : null;
  const isError = site?.last_status?.startsWith("error");
  const changesCount = history.filter((h) => h.event_type === "change").length;
  const seasonClosed = site?.season_status === "closed";
  const seasonOpen = site?.season_status === "open";
  const nextCheckLabel = site?.next_check_at
    ? formatDistanceToNow(new Date(site.next_check_at), { addSuffix: true, locale: ru })
    : null;

  return (
    <div className="relative min-h-screen">
      <div className="absolute inset-0 grid-bg pointer-events-none" aria-hidden />
      <main className="relative mx-auto max-w-4xl px-5 py-10 md:py-14">
        {/* Header */}
        <header className="flex flex-col gap-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-clay/40 bg-clay/10 px-3 py-1 text-xs text-clay-foreground/90 font-mono-display w-fit">
            <span
              className={`size-1.5 rounded-full ${
                !site?.is_active
                  ? "bg-muted-foreground"
                  : seasonClosed
                    ? "bg-warning"
                    : "bg-primary pulse-dot"
              }`}
            />
            {!site?.is_active
              ? "мониторинг не запущен"
              : seasonClosed
                ? "сезон закрыт • опрос раз в 10 мин"
                : seasonOpen
                  ? "мониторинг активен • интервал 60с"
                  : "ожидание первой проверки…"}
          </div>
          <h1 className="font-mono-display text-4xl md:text-5xl font-semibold tracking-tight">
            <span className="text-primary glow-text">kort40</span>
            <span className="text-muted-foreground">_</span>
            <span className="text-foreground">watch</span>
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Отслеживание свободных слотов на{" "}
            <a
              href="https://kort40.online"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              kort40.online
            </a>{" "}
            на 30 дней вперёд. Как только корт освобождается — приходит уведомление в Telegram.
          </p>
        </header>

        {/* Season-closed banner */}
        {seasonClosed && site?.is_active && (
          <div className="mt-6 rounded-lg border border-warning/40 bg-warning/10 p-4">
            <div className="flex items-start gap-3">
              <Clock className="size-4 text-warning shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-mono-display font-medium text-warning">
                  Сезон ещё не открыт — бронирование на kort40.online закрыто
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  Это нормально: вне сезона API сайта не отдаёт расписание. Мы тихо опрашиваем сайт раз в
                  10 минут и пришлём в Telegram уведомление в ту же минуту, как бронирование откроется
                  и появятся первые свободные слоты.
                </p>
                {nextCheckLabel && (
                  <p className="mt-2 text-[11px] text-muted-foreground font-mono-display">
                    следующая проверка: {nextCheckLabel}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Stats */}
        <section className="mt-8 grid grid-cols-3 gap-3">
          <StatCard
            icon={<Activity className="size-4" />}
            label="свободно"
            value={slotsCount ?? "—"}
          />
          <StatCard
            icon={<Bell className="size-4" />}
            label="новых событий"
            value={changesCount}
            accent="warning"
          />
          <StatCard
            icon={<Clock className="size-4" />}
            label="статус"
            value={
              isError
                ? "ошибка"
                : seasonClosed
                  ? "закрыт"
                  : seasonOpen
                    ? "open"
                    : site?.is_active
                      ? "live"
                      : "—"
            }
            accent={isError ? "destructive" : "default"}
          />
        </section>

        {/* Telegram channel info */}
        <Card className="mt-6 p-5 bg-card/60 backdrop-blur">
          <div className="flex items-center gap-2 mb-2">
            <Lock className="size-4 text-primary" />
            <h2 className="font-mono-display font-medium text-sm">Общий Telegram-чат</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Уведомления о свободных слотах автоматически уходят в фиксированный
            Telegram-чат, заданный серверным секретом{" "}
            <code className="text-primary">TELEGRAM_CHAT_ID</code>. Никто из посетителей этого
            сайта не может его подменить. Чтобы пригласить друзей — просто добавьте их в этот
            чат/группу в Telegram.
          </p>
          <Button onClick={sendTest} disabled={testing} className="gap-1.5" variant="secondary">
            <Send className="size-3.5" />
            {testing ? "Отправка…" : "Отправить тестовое сообщение"}
          </Button>
        </Card>

        {/* Tabs: calendar / history / settings */}
        <section className="mt-8">
          <Tabs defaultValue="calendar" className="w-full">
            <TabsList className="grid grid-cols-3 w-full max-w-md bg-card/60 backdrop-blur">
              <TabsTrigger value="calendar" className="gap-1.5 font-mono-display text-xs">
                <CalendarDays className="size-3.5" />
                Календарь
              </TabsTrigger>
              <TabsTrigger value="history" className="gap-1.5 font-mono-display text-xs">
                <History className="size-3.5" />
                События
              </TabsTrigger>
              <TabsTrigger value="settings" className="gap-1.5 font-mono-display text-xs">
                <Settings className="size-3.5" />
                Настройки
              </TabsTrigger>
            </TabsList>

            <TabsContent value="calendar" className="mt-4">
              <SlotsCalendar siteId={site?.id ?? null} lastCheckedAt={site?.last_checked_at ?? null} />
            </TabsContent>

            <TabsContent value="history" className="mt-4">
              <HistoryFeed entries={history} site={site} />
            </TabsContent>

            <TabsContent value="settings" className="mt-4">
              <KortConfigCard site={site} />
            </TabsContent>
          </Tabs>
        </section>

        <footer className="mt-14 pt-6 border-t border-border/60 text-xs text-muted-foreground font-mono-display flex flex-wrap items-center justify-between gap-2">
          <span>kort40.online • powered by Lovable Cloud</span>
          <span>interval 60s • horizon 30d</span>
        </footer>
      </main>
    </div>
  );
};

function StatCard({
  icon,
  label,
  value,
  accent = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  accent?: "default" | "warning" | "destructive";
}) {
  const color =
    accent === "warning"
      ? "text-warning"
      : accent === "destructive"
        ? "text-destructive"
        : "text-primary";
  return (
    <Card className="p-4 bg-card/60 backdrop-blur">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground font-mono-display uppercase tracking-wider">
        <span className={color}>{icon}</span>
        {label}
      </div>
      <div className={`mt-2 font-mono-display text-2xl md:text-3xl font-semibold ${color} truncate`}>
        {value}
      </div>
    </Card>
  );
}

export default Index;