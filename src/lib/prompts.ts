import type { PromptSpec } from "./types";

export const PROMPT_LIBRARY: PromptSpec[] = [
  {
    id: "url-shortener",
    title: "URL Shortener",
    question:
      "Design a URL shortening service like bit.ly. Users give us a long URL and get back a short link that redirects.",
    context:
      "A consumer-facing link shortener. Reads (redirects) vastly outnumber writes (link creation).",
    factSheet: [
      { q: "How many users / what's the scale?", a: "About 100M monthly active users creating ~500M links per month; ~10B redirects per month. So roughly 200 writes/sec and 4,000 reads/sec average, 5-10x at peak." },
      { q: "Short link length / alphabet?", a: "Short links should be as short as possible — aim for 7 characters from [a-zA-Z0-9], giving ~3.5 trillion possibilities." },
      { q: "Do links expire?", a: "By default links never expire. Supporting optional TTL is a nice extension if time permits." },
      { q: "Custom aliases?", a: "Yes, users can optionally specify a custom alias; those must be unique and can be rejected if taken." },
      { q: "Analytics required?", a: "Basic click counts would be nice but are a nice-to-have — don't let it dominate the design." },
      { q: "Consistency requirements?", a: "A created link should work immediately-ish; small propagation delay is acceptable. Redirects must be fast and reliable — availability matters more than strict consistency." },
      { q: "One short URL per long URL, or unique per request?", a: "Either is acceptable — state your choice and its trade-off." },
    ],
    deepDiveAngles: [
      "ID generation strategy (counter + base62 vs hash vs pre-generated keys) and collision handling",
      "Read path: caching hot links, 301 vs 302 redirect semantics",
      "Write path at peak and DB choice (key-value vs relational)",
      "Abuse/spam mitigation",
    ],
  },
  {
    id: "twitter-feed",
    title: "Social Feed (Twitter/X)",
    question:
      "Design a social media timeline: users post short posts and follow other users; each user's home feed shows recent posts from accounts they follow.",
    context:
      "A text-first microblogging service at large consumer scale. Read-heavy.",
    factSheet: [
      { q: "Scale?", a: "200M DAU, ~500M posts/day (~6k/sec avg, 50k peak), feed reads ~10x that. Average user follows ~300 accounts." },
      { q: "What content types?", a: "Text up to 280 chars; images/video are out of scope for the core design — note them as an extension." },
      { q: "Ranking or chronological?", a: "Start with chronological; a ranked feed is a follow-up. The interesting part is fan-out." },
      { q: "Celebrity accounts?", a: "Yes — some accounts have 50M+ followers. This is intentional and should change your fan-out design." },
      { q: "How fresh must the feed be?", a: "A few seconds of staleness is fine. Eventual consistency is acceptable." },
      { q: "In scope?", a: "Posting, following/unfollowing, and reading the home feed. DMs, search, ads, trends — explicitly out of scope." },
    ],
    deepDiveAngles: [
      "Fan-out-on-write vs fan-out-on-read, and the hybrid for celebrities",
      "Feed data model and storage (timeline cache vs store of record)",
      "Handling the write hot-spot and read hot-spot asymmetrically",
      "Pagination and feed refresh consistency",
    ],
  },
  {
    id: "chat",
    title: "Chat Application",
    question:
      "Design a 1:1 and small-group chat application — think the messaging core of WhatsApp or Slack.",
    context: "Real-time messaging. Delivery guarantees and online presence matter.",
    factSheet: [
      { q: "Scale?", a: "50M DAU, ~10B messages/day total across all conversations. Average message under 1KB of text." },
      { q: "Group size?", a: "Groups are small — cap at ~500 members. No broadcast channels." },
      { q: "Delivery guarantees?", a: "At-least-once delivery; the client dedupes. Ordering within a conversation should be preserved." },
      { q: "Read receipts / typing indicators?", a: "Yes, both — but they're best-effort, not guaranteed." },
      { q: "Encryption?", a: "Assume TLS in transit; end-to-end encryption is out of scope unless you want to discuss it briefly." },
      { q: "Media attachments?", a: "Out of scope for the core loop — mention how they'd slot in." },
      { q: "Offline delivery?", a: "Yes — messages sent to offline users must be delivered when they reconnect." },
    ],
    deepDiveAngles: [
      "Connection management: WebSocket/long-poll gateways, connection state, presence",
      "Message storage: partitioning by conversation, ordering guarantees, sync on reconnect",
      "Delivery semantics: ACKs, retries, dedupe IDs",
      "Fan-out to group members and multi-device sync",
    ],
  },
  {
    id: "rate-limiter",
    title: "Rate Limiter",
    question:
      "Design a distributed rate limiter that an API platform can put in front of its services to throttle clients.",
    context: "Infrastructure component used by many internal services.",
    factSheet: [
      { q: "What are we limiting?", a: "API requests per client (API key) — e.g., 1000 requests/minute. Rules differ per endpoint and per customer tier." },
      { q: "Scale?", a: "The platform handles ~1M requests/sec at peak across ~10k services. The limiter must add <1ms of latency p99 on the happy path." },
      { q: "Where does it run?", a: "As a library/sidecar in each service, or a gateway middleware — your choice, but it must be distributed since services run many replicas." },
      { q: "Exact or approximate limits?", a: "Approximate is fine — being off by a few requests across replicas is acceptable." },
      { q: "Response on limit?", a: "HTTP 429 with a Retry-After header. The limiter also needs a way to update rules without redeploys." },
      { q: "Burst handling?", a: "Short bursts above the sustained rate should be allowed — clients aren't perfectly smooth." },
    ],
    deepDiveAngles: [
      "Algorithm choice: token bucket vs fixed/sliding window vs sliding log — memory vs accuracy",
      "Distributed state: Redis vs local+sync, race conditions, failover behavior",
      "Rule storage and hot reload",
      "Behavior under Redis/partition failure: fail open vs closed",
    ],
  },
  {
    id: "rideshare",
    title: "Ride Sharing (Uber/Lyft)",
    question:
      "Design the backend for a ride-sharing service: riders request a ride, we match them with a nearby driver, and both parties track the trip.",
    context: "Location-heavy, real-time marketplace matching.",
    factSheet: [
      { q: "Scale?", a: "10M rides/day globally, concentrated in cities. ~1M concurrent active trips at peak evening hours." },
      { q: "How do drivers report location?", a: "Driver apps emit GPS updates every ~4 seconds while online." },
      { q: "Matching requirements?", a: "Match a rider to a nearby available driver — typically within ~5 minutes ETA. Matching doesn't need to be globally optimal." },
      { q: "Pricing in scope?", a: "Basic estimate only (distance + time). Surge pricing is an interesting extension if time permits." },
      { q: "Consistency?", a: "A driver must never be dispatched to two riders — that's the one hard consistency requirement." },
      { q: "Scope?", a: "Request → match → trip tracking → completion. Payments, ratings, driver onboarding are out of scope." },
    ],
    deepDiveAngles: [
      "Geospatial indexing: geohash/quadtree/S2, updating driver positions at scale",
      "Matching flow: dispatch service, driver accept/reject, timeout + re-match",
      "Consistency on dispatch (locking/leases) so a driver isn't double-booked",
      "Location streaming pipeline and trip state machine",
    ],
  },
  {
    id: "dropbox",
    title: "File Sync (Dropbox)",
    question:
      "Design a file synchronization service: files uploaded on one device appear on the user's other devices, with sharing between users.",
    context: "Consumer cloud storage — large blobs, delta sync, offline support.",
    factSheet: [
      { q: "Scale?", a: "50M users, average 500 files each, average file size ~500KB. ~10% of users actively syncing at any time." },
      { q: "File size limits?", a: "Up to 2GB per file. Must handle large files efficiently — can't treat them as one blob." },
      { q: "Delta sync?", a: "Yes — editing one part of a large file shouldn't re-upload the whole thing." },
      { q: "Offline edits?", a: "Clients can go offline and sync when they return. Last-writer-wins conflicts are acceptable; flag them to the user." },
      { q: "Sharing semantics?", a: "Shared folders — changes by any member sync to all members." },
      { q: "Version history?", a: "Keep it simple — 30 days of version history is a stretch goal." },
    ],
    deepDiveAngles: [
      "Chunking (fixed vs content-defined), hashing, and dedup — including across users",
      "Metadata service vs blob storage split",
      "Sync protocol: how clients learn about changes (long-poll/notification + pull)",
      "Conflict handling and consistency model",
    ],
  },
  {
    id: "web-crawler",
    title: "Web Crawler",
    question:
      "Design a web crawler that continuously fetches and indexes pages for a search engine.",
    context: "Batch-oriented, politeness-constrained distributed crawling.",
    factSheet: [
      { q: "Scale?", a: "1B pages per month re-crawl rate; ~10B known URLs in the frontier." },
      { q: "What do we store?", a: "Raw page HTML plus extracted outlinks and basic metadata. Rendering JS is out of scope." },
      { q: "Politeness?", a: "Strict — respect robots.txt and limit to ~1 request per few seconds per domain." },
      { q: "Freshness?", a: "Popular pages should be re-crawled more often than long-tail pages — assume a per-URL priority exists." },
      { q: "Dedup?", a: "Yes — skip near-duplicate content and don't fetch the same URL twice in a window." },
      { q: "Failure handling?", a: "Dead links and timeouts are routine; retry with backoff a few times then drop." },
    ],
    deepDiveAngles: [
      "Frontier design: prioritization, per-domain queues, politeness scheduling",
      "URL dedup at scale (bloom filters, sharded stores)",
      "Content dedup / near-dup detection (simhash)",
      "Worker architecture and fault tolerance (checkpointing fetch state)",
    ],
  },
  {
    id: "ticketmaster",
    title: "Event Ticketing (Ticketmaster)",
    question:
      "Design a ticketing system for popular events: users browse events, hold seats, and complete purchase. The hard part is high-demand onsales.",
    context: "E-commerce with extreme flash-sale contention on a finite inventory.",
    factSheet: [
      { q: "Scale?", a: "Normal traffic is modest, but a hot onsale gets ~500k concurrent users for ~50k seats. Everything interesting happens in the first 2 minutes." },
      { q: "Seat model?", a: "Reserved seating — specific seats in a venue map. A seat is either available, held, or sold." },
      { q: "Hold semantics?", a: "A user can hold seats for 10 minutes to complete checkout; then the hold expires and seats return to inventory." },
      { q: "Hard requirement?", a: "Never double-sell a seat. This is the one invariant that cannot break." },
      { q: "Fairness?", a: "A waiting-room / queue for hot onsales is expected — you should propose something for fairness under extreme load." },
      { q: "Payments?", a: "Integrate with an external payment processor — treat it as a black box with ~1s latency and occasional failures." },
    ],
    deepDiveAngles: [
      "Seat inventory consistency: hold/sold state machine, expiry, avoiding double-sell",
      "Flash-sale traffic: virtual waiting room, queueing, draining thundering herd",
      "DB choice and concurrency control for seat rows (locks vs CAS vs event-driven)",
      "Payment failure during hold; idempotent checkout",
    ],
  },
  {
    id: "notifications",
    title: "Notification Service",
    question:
      "Design a notification platform that product teams use to send push, email, and SMS notifications to users.",
    context: "Multi-channel infra service — high volume, at-least-once with dedup.",
    factSheet: [
      { q: "Scale?", a: "5M notifications/day typical, spiking to ~50M during big product announcements." },
      { q: "Channels?", a: "Push (APNs/FCM), email (SES-like), SMS (Twilio-like). All third-party delivery — we own routing, templating, and delivery tracking." },
      { q: "Guarantees?", a: "At-least-once per channel with dedup on send; a user must never get the same push twice. Order between notifications is not guaranteed." },
      { q: "User preferences?", a: "Yes — per-channel opt-outs and a quiet-hours setting that delays non-urgent sends." },
      { q: "Templates?", a: "Product teams register templates with variables; the service renders them." },
      { q: "Tracking?", a: "Send/delivery status per notification; opens/clicks are nice-to-have." },
    ],
    deepDiveAngles: [
      "Queue-per-channel architecture, rate limits per provider, backoff on provider errors",
      "Dedup/idempotency keys across retries and worker crashes",
      "Preference + quiet-hours evaluation in the send path",
      "Priority tiers (OTP vs marketing) and isolation between tenants",
    ],
  },
  {
    id: "typeahead",
    title: "Search Typeahead",
    question:
      "Design a search autocomplete: as a user types, show the top ~5 suggestions within tens of milliseconds.",
    context: "Read-path-heavy autocomplete for a large search product.",
    factSheet: [
      { q: "Scale?", a: "~1B searches/day; autocomplete sees ~10x that in keystrokes — ~10M QPS peak across edge POPs is unrealistic, but assume ~100k QPS." },
      { q: "Latency budget?", a: "p99 under ~50ms for suggestions — it's on the user's critical typing path." },
      { q: "Data source?", a: "Suggestions come from historical query popularity, refreshed periodically — they don't need to be real-time." },
      { q: "Personalization?", a: "Global suggestions only — no per-user personalization." },
      { q: "Languages?", a: "English first; the design shouldn't preclude other languages." },
      { q: "Update frequency?", a: "Suggestion data rebuilt hourly or daily is fine." },
    ],
    deepDiveAngles: [
      "Data structure: trie vs prefix-hash index, top-k storage per node",
      "Serving path: in-memory/edge caching, CDN-style distribution",
      "Building the index offline and shipping updates without downtime",
      "Ranking signals and filtering (safe-search) in the hot path",
    ],
  },
];

export function getLibraryPrompt(id: string): PromptSpec | undefined {
  return PROMPT_LIBRARY.find((p) => p.id === id);
}
