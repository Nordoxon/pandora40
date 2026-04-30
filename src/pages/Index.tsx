import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KortConfigCard, type KortSite } from "@/components/KortConfigCard";
import { HistoryFeed, type HistoryEntry } from "@/components/HistoryFeed";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Bell, Send, Activity, Clock } from "lucide-react";

const CHAT_ID_KEY = "kort40-watch.default-chat-id";

const Index = () => {
  const [site, setSite] = useState<KortSite | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [defaultChatId, setDefaultChatId] = useState<string>(
    () => localStorage.getItem(CHAT_ID_KEY) ?? "",
  );
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

  function saveChatId() {
    localStorage.setItem(CHAT_ID_KEY, defaultChatId.trim());
    toast.success("chat_id сохранён");
  }

  async function sendTest() {
    if (!defaultChatId.trim()) {
      toast.error("Сначала введите chat_id");
      return;
    }
    setTesting(true);
    try {
      const { error } = await supabase.functions.invoke("telegram-test", {
        body: { chat_id: defaultChatId.trim() },
      });
      if (error) throw error;
      toast.success("Тестовое сообщение отправлено в Telegram");
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

  return (
    <div className="relative min-h-screen">
      <div className="absolute inset-0 grid-bg pointer-events-none" aria-hidden />
      <main className="relative mx-auto max-w-4xl px-5 py-10 md:py-14">
        {/* Header */}
        <header className="flex flex-col gap-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-clay/40 bg-clay/10 px-3 py-1 text-xs text-clay-foreground/90 font-mono-display w-fit">
            <span
              className={`size-1.5 rounded-full ${
                site?.is_active ? "bg-primary pulse-dot" : "bg-muted-foreground"
              }`}
            />
            {site?.is_active ? "мониторинг активен • интервал 60с" : "мониторинг не запущен"}
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
            value={isError ? "ошибка" : site?.is_active ? "live" : "—"}
            accent={isError ? "destructive" : "default"}
          />
        </section>

        {/* Telegram chat_id helper */}
        <Card className="mt-6 p-5 bg-card/60 backdrop-blur">
          <div className="flex items-center gap-2 mb-3">
            <Send className="size-4 text-primary" />
            <h2 className="font-mono-display font-medium text-sm">Telegram chat_id по умолчанию</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Этот chat_id будет автоматически подставлен при запуске мониторинга. Узнать chat_id —
            напишите <code className="text-primary">@userinfobot</code>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="chat" className="text-xs">chat_id</Label>
              <Input
                id="chat"
                placeholder="123456789"
                value={defaultChatId}
                onChange={(e) => setDefaultChatId(e.target.value)}
                className="font-mono-display"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={saveChatId}>Сохранить</Button>
              <Button onClick={sendTest} disabled={testing} className="gap-1.5">
                <Send className="size-3.5" />
                {testing ? "…" : "Тест"}
              </Button>
            </div>
          </div>
        </Card>

        {/* Monitor card */}
        <section className="mt-8">
          <h2 className="font-mono-display text-lg font-medium mb-3">Мониторинг</h2>
          <KortConfigCard site={site} defaultChatId={defaultChatId} />
        </section>

        {/* History */}
        <section className="mt-10">
          <h2 className="font-mono-display text-lg font-medium mb-3">События</h2>
          <HistoryFeed entries={history} site={site} />
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