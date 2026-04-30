import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus, Trophy, Globe } from "lucide-react";

interface Props {
  defaultChatId?: string;
}

export function AddSiteDialog({ defaultChatId }: Props) {
  const [open, setOpen] = useState(false);
  const [monitorType, setMonitorType] = useState<"html" | "kort40">("kort40");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [chatId, setChatId] = useState(defaultChatId ?? "");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (!chatId.trim()) {
        toast.error("Укажите Telegram chat_id");
        setLoading(false);
        return;
      }

      let normalizedUrl: string;
      let finalLabel: string | null = label.trim() || null;

      if (monitorType === "kort40") {
        normalizedUrl = "https://kort40.online";
        if (!finalLabel) finalLabel = "kort40.online — свободные слоты";
      } else {
        normalizedUrl = url.trim();
        if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = "https://" + normalizedUrl;
        try {
          new URL(normalizedUrl);
        } catch {
          toast.error("Некорректный URL");
          setLoading(false);
          return;
        }
      }

      const { error } = await supabase.from("watched_sites").insert({
        url: normalizedUrl,
        label: finalLabel,
        telegram_chat_id: chatId.trim(),
        monitor_type: monitorType,
      });
      if (error) throw error;
      toast.success(
        monitorType === "kort40"
          ? "Мониторинг kort40 запущен. Первая проверка — в течение минуты."
          : "Сайт добавлен. Первая проверка запустится в течение минуты."
      );
      setUrl("");
      setLabel("");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="gap-2 font-mono-display">
          <Plus className="size-4" />
          Добавить сайт
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono-display">Новый объект мониторинга</DialogTitle>
          <DialogDescription>
            Проверка запускается раз в минуту. При обнаружении изменений приходит уведомление в Telegram.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Тип мониторинга</Label>
            <RadioGroup
              value={monitorType}
              onValueChange={(v) => setMonitorType(v as "html" | "kort40")}
              className="grid grid-cols-1 gap-2"
            >
              <label
                htmlFor="t-kort40"
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                  monitorType === "kort40" ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50"
                }`}
              >
                <RadioGroupItem value="kort40" id="t-kort40" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <Trophy className="size-4 text-primary" />
                    kort40.online — свободные слоты
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Логин по сохранённым учётным данным, проверка на 30 дней вперёд, уведомление о новых освободившихся кортах.
                  </p>
                </div>
              </label>
              <label
                htmlFor="t-html"
                className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                  monitorType === "html" ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/50"
                }`}
              >
                <RadioGroupItem value="html" id="t-html" className="mt-0.5" />
                <div className="flex-1">
                  <div className="flex items-center gap-2 font-medium text-sm">
                    <Globe className="size-4 text-primary" />
                    Обычный сайт (HTML)
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Сравнение HTML страницы по SHA-256. Подходит только для публичных страниц без логина.
                  </p>
                </div>
              </label>
            </RadioGroup>
          </div>

          {monitorType === "html" && (
            <div className="space-y-2">
              <Label htmlFor="url">URL</Label>
              <Input
                id="url"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="label">Метка (опционально)</Label>
            <Input
              id="label"
              placeholder={monitorType === "kort40" ? "например: Корты по будням" : "например: Главная страница"}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat">Telegram chat_id</Label>
            <Input
              id="chat"
              placeholder="123456789"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              Узнать chat_id: напишите боту <code className="text-primary">@userinfobot</code> в Telegram.
            </p>
          </div>
          {monitorType === "kort40" && (
            <p className="text-xs text-muted-foreground rounded-md border border-border/60 bg-secondary/40 p-3">
              Учётные данные kort40 берутся из секретов <code className="text-primary">KORT40_EMAIL</code> и{" "}
              <code className="text-primary">KORT40_PASSWORD</code>. Если нужно их обновить — измените секреты в настройках Cloud.
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={loading}>
              {loading ? "Сохранение…" : "Добавить"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
