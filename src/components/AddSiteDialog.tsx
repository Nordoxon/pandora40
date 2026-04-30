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
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus } from "lucide-react";

interface Props {
  defaultChatId?: string;
}

export function AddSiteDialog({ defaultChatId }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [chatId, setChatId] = useState(defaultChatId ?? "");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      let normalized = url.trim();
      if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;
      try {
        new URL(normalized);
      } catch {
        toast.error("Некорректный URL");
        setLoading(false);
        return;
      }
      if (!chatId.trim()) {
        toast.error("Укажите Telegram chat_id");
        setLoading(false);
        return;
      }
      const { error } = await supabase.from("watched_sites").insert({
        url: normalized,
        label: label.trim() || null,
        telegram_chat_id: chatId.trim(),
      });
      if (error) throw error;
      toast.success("Сайт добавлен. Первая проверка запустится в течение минуты.");
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
          <DialogTitle className="font-mono-display">Новый сайт для мониторинга</DialogTitle>
          <DialogDescription>
            HTML страницы будет проверяться раз в минуту. При любом изменении придёт уведомление в Telegram.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
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
          <div className="space-y-2">
            <Label htmlFor="label">Метка (опционально)</Label>
            <Input
              id="label"
              placeholder="например: Главная страница"
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
