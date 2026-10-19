# Configuration

Create a `.env` file in the repository root. Only `OPENAI_API_KEY` is required; the rest override defaults.

```bash
OPENAI_API_KEY=sk-...        # the project needs Live model access and session storage enabled
LIVE_MODEL=gpt-live-1        # optional, default in src/lib/persona.ts
LIVE_BACKEND_MODEL=gpt-5.6-terra    # optional, default in src/lib/persona.ts
GRADING_MODEL=gpt-5.6-terra         # optional, default in the grade route
PROMPT_GEN_MODEL=gpt-5.6-terra      # optional, default in src/lib/promptGen.ts
IMAGE_PUSH_MODE=on           # on | off
OPENAI_BASE_URL=https://api.openai.com/v1  # optional API or mock override
```

The model names above are the defaults in the code at the time of writing. Whether your OpenAI account can use them is not something this repository can check, so set the variables to models you have access to.

## Notes

- Cost: the voice layer is billed per minute, plus backend and grading tokens. A figure of about $0.05 per minute for voice has been quoted; it is an unverified estimate, so check current OpenAI pricing.
- SQLite lives at `data/app.db`; snapshots and recordings are under `data/`. See [persistence.md](persistence.md).
- Recordings need session storage enabled on the OpenAI project. Retention of stored recordings is set by OpenAI, not by this code; an expiry of 30 days has been quoted but was not verified here.
