ALTER TYPE "public"."ticket_action" ADD VALUE 'merged' BEFORE 'undo';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "ticket_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_ticket_idx" ON "messages" USING btree ("ticket_id");--> statement-breakpoint
/* Isi mundur untuk tiket yang sudah ada, supaya messages.ticket_id boleh
   dianggap satu-satunya sumber "pesan ini bagian tiket mana". Tanpa ini,
   swipe-reply ke tiket lama tidak menemukan tiketnya lewat jalur baru. */
UPDATE "messages" m SET "ticket_id" = t."id"
FROM "tickets" t WHERE t."stanza_id" = m."stanza_id";--> statement-breakpoint
UPDATE "messages" m SET "ticket_id" = t."id"
FROM "tickets" t
WHERE m."direction" = 'out'
  AND m."reply_to_stanza_id" = t."stanza_id"
  AND m."ticket_id" IS NULL;
