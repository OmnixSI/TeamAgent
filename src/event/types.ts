/** Shared event-layer v2 contracts. Parsing, rendering and state transitions live in their owners. */

export type MediaOrigin = "own" | "quote" | "forward";

/** Same card and Bili field shapes as the existing Inbound boundary. */
export type Card = {
  type: string;
  name?: string;
  title?: string;
  desc?: string;
  url?: string;
  source?: string;
  preview?: string;
  note?: string;
};

export type Bili = { bvid?: string; aid?: string; short?: string; url: string };

/** A reply preview or a node in a potentially nested forward. */
export type SegmentNode = {
  authorId?: string;
  authorName?: string;
  segments: Segment[];
};

/** `type` discriminates segments; `face.kind` keeps its face/mface meaning. */
export type Segment =
  | { type: "text"; text: string }
  | { type: "mention"; id: string; name?: string; self: boolean }
  | { type: "face"; id: string; name?: string; kind: "face" | "mface"; ext?: string; face_unparsed?: true }
  | {
      type: "image";
      url: string;
      contentType: string;
      w?: number;
      h?: number;
      size?: number;
      animated: boolean;
      owner: string;
      origin: MediaOrigin;
      sourceMessageId?: string;
    }
  | {
      type: "voice";
      url: string;
      wavUrl?: string;
      asr?: string;
      owner: string;
      origin: MediaOrigin;
    }
  | {
      type: "video";
      url: string;
      filename?: string;
      size?: number;
      owner: string;
      origin: MediaOrigin;
    }
  | {
      type: "file";
      url: string;
      filename?: string;
      size?: number;
      owner: string;
      origin: MediaOrigin;
    }
  | { type: "card"; card: Card; bili?: Bili }
  | { type: "reply"; refIdx: string; preview: SegmentNode }
  | { type: "forward"; nodes: SegmentNode[]; truncated: boolean };

export type EventActor = { id: string; name: string; bot: boolean };

export type EventNotice = "bot_added" | "bot_removed" | "active_rejected" | "active_allowed";

export type NormalizedEvent = {
  kind: "message" | "notice";
  /** Original platform event type, including unknown types handled at the ingress boundary. */
  type: string;
  id: string;
  groupId: string;
  actor: EventActor;
  /** Unix timestamp in milliseconds, not the raw platform timestamp string. */
  ts: number;
  msgIdx?: string;
  refIdx?: string;
  segments: Segment[];
  mentionsBot: boolean;
  notice?: EventNotice;
};

export type EvidenceStatus = "ok" | "partial" | "failed" | "unsupported";

export type EvidenceResult = {
  status: EvidenceStatus;
  reason?: string;
  text?: string;
  source: string;
  owner?: string;
};

/** Existing outbox states plus the v2-only held/retry states. */
export type OutboxStatus = "pending" | "held" | "retry" | "sending" | "sent" | "failed" | "unknown" | "skipped";

/** SQL row shapes retain the column names and nullability specified by the migration. */
export type PassiveClaimRow = {
  msg_id: string;
  group_id: string;
  source_ts: number;
  used: number;
};

export type OutboxSendRow = {
  id: string;
  passive_msg_id: string | null;
  msg_seq: number | null;
  not_before: number;
  tries: number;
  reason: string | null;
  lock_tok: string | null;
  claimed_at: number | null;
};

export type SendLaneRow = { group_id: string; holder: string; lease_until: number };
