# Landing page v2 imagery

Generated imagery for the marketing landing page (`components/marketing/home`).
Referenced in code as `/marketing/landing-v2/<file>`.

Only the files the page actually renders are shipped here, as WebP
(the 2400x1600 / 1600x1200 / 1800x1200 masters were ~14 MB of PNG; these
are ~450 KB total and `next/image` resizes them per viewport).

| File | Used by |
|---|---|
| `hero-vehicle.webp` | hero plate |
| `veh-01` … `veh-06` `.webp` | vehicle floor cards; `veh-02` also in the accounting demo |
| `delivery-handover.webp` | CTA band |

Filenames are a contract with the page — a regenerated image with the same
name drops in with no code change. Generation brief and style contract:
SCRUM-301 / Slack `#scrum-301`.
