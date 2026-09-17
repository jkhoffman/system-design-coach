export interface LiveEvent {
  type: string;
  event_id?: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation_id?: string | null;
  delegation?: { id?: string };
  response_id?: string;
  response?: { id?: string };
  session?: { id?: string };
  usage?: Record<string, unknown>;
  reason?: string;
  event?: {
    type: string;
    response_id?: string;
    response?: { id?: string };
    item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  };
  error?: { message?: string };
  message?: string;
}

export function parseLiveEvent(raw: string): LiveEvent | null {
  try {
    const event = JSON.parse(raw);
    return event && typeof event === "object" && typeof event.type === "string" ? event : null;
  } catch { return null; }
}

/** Completion events are idempotent even when multiple response envelopes arrive. */
export class LiveActivity {
  private delegations = new Set<string>();
  private responses = new Set<string>();
  private completed = new Set<string>();
  private responseDelegations = new Map<string, string>();
  private anonymousDelegation = false;
  private anonymousResponse = false;

  get pending(): boolean {
    return this.delegations.size > 0 || this.responses.size > 0 || this.anonymousDelegation || this.anonymousResponse;
  }

  expectResponse(): void { this.anonymousResponse = true; }

  observe(event: LiveEvent): void {
    const type = event.type === "response.event" ? event.event?.type : event.type;
    const delegation = event.delegation_id ?? event.delegation?.id;
    const response = event.event?.response_id ?? event.event?.response?.id ?? event.response_id ?? event.response?.id;
    if (type === "session.delegation.created") {
      if (delegation) { if (!this.completed.has(`d:${delegation}`)) this.delegations.add(delegation); }
      else this.anonymousDelegation = true;
    }
    if (type === "response.created") {
      if (response) {
        this.anonymousResponse = false;
        if (!this.completed.has(`r:${response}`)) this.responses.add(response);
        if (delegation) this.responseDelegations.set(response, delegation);
      } else this.anonymousResponse = true;
    }
    if (type === "response.completed" || type === "session.delegation.completed") {
      if (response) {
        this.responses.delete(response);
        this.completed.add(`r:${response}`);
      } else this.anonymousResponse = false;
      const parent = delegation ?? (response ? this.responseDelegations.get(response) : undefined);
      if (parent) {
        this.delegations.delete(parent);
        this.completed.add(`d:${parent}`);
        if (type === "session.delegation.completed") {
          for (const [r, d] of this.responseDelegations) {
            if (d === parent) { this.responses.delete(r); this.completed.add(`r:${r}`); }
          }
        }
      } else if (!response) this.anonymousDelegation = false;
    }
  }
}
