# Peak 10 Energy — Interactive Deal Microsite ("New Age VDR")

## Concept

A web-based, auth-gated interactive management presentation for potential buyers and partners — not a traditional document vault, but a tabbed, data-rich deal microsite hosted on Netlify. Think of the existing P10 Type Curves dashboard expanded into a full deal presentation with maps, financials, contracts, and gated downloads, all behind per-buyer login credentials with usage tracking.

## Core Requirements

1. **Web-based** — buyers access via browser at a custom URL, nothing to install
2. **Per-buyer authentication** — unique username/password per potential partner or buyer
3. **Usage/access tracking** — audit trail of who logged in, what they viewed, what they downloaded
4. **Custom domain per VDR** — distinct URL per deal (not `*.netlify.app`), using Peak 10 Energy's domain (e.g., `acme.vdr.peak10energy.com`)
5. **Interactive map** — MapLibre GL JS with shapefile-derived layers, click-to-detail functionality
6. **Gated file downloads** — certain data and files available for download, logged per user
7. **Watermarked contract/document viewing** — view-only PDFs with blanket watermarks
8. **Peak 10 brand aesthetic** — matching the look and feel of the P10 Type Curves dashboard

## Tab Structure

| Tab | Content |
|---|---|
| Overview | Executive summary / deal highlights |
| Type Curves | Production type curves (similar to existing `p10-type-curves` app) |
| Map(s) | Interactive MapLibre map with shapefile layers (leases, units, wells, pipelines) |
| LOS | Lease Operating Statement tables and graphs |
| Contracts | Operating agreements, PSAs — watermarked, view-only PDF viewer |
| Lease Schedule | Tract/lease schedule — sortable, filterable tables |
| Downloads | Gated file downloads with access logging |

## Architecture

### Stack
- **Frontend**: Vite + React + TypeScript + Tailwind CSS (same stack as `mcquire-tracker-app`)
- **Hosting**: Netlify (Pro or Business tier)
- **Auth**: Clerk (or Auth0 / Supabase Auth)
- **Database**: Supabase (Postgres) for deal metadata, user-deal mappings, and access logs
- **File Storage**: Cloudflare R2 or AWS S3 (private bucket) for downloadable files and source PDFs
- **Serverless**: Netlify Functions for auth checks, presigned URL generation, watermarking, and access logging

### Brand / Styling
- Reuse the Peak 10 color palette already codified in `mcquire-tracker-app/tailwind.config.js`:
  - Navy: `#1F3864`
  - Brand Blue / P10: `#2E75B6`
  - Brand Light: `#BDD7EE`
- Match the layout, typography, and component patterns from the `p10-type-curves` dashboard (requires access to that repo or screenshots to achieve a pixel-accurate match)

### Authentication & Access Control
- **Clerk** (recommended) or Auth0 for user management
  - Admin dashboard to create/revoke users per deal
  - MFA, password reset, session management included
  - React integration via `<SignedIn>` wrapper
- Netlify Identity is deprecated — do not use

### Per-Deal Custom Domains
Two options:

1. **Per-deal Netlify sites** (simpler, recommended for low deal volume)
   - Each deal gets its own Netlify site on a subdomain: `acme.vdr.peak10energy.com`
   - Provision via Netlify API (~20 lines of script), tear down after close
   - Requires Netlify Pro

2. **Single wildcard site** (more efficient at scale)
   - One site on `*.vdr.peak10energy.com`
   - Edge function reads subdomain, loads deal-specific config
   - Requires Netlify Business

### Interactive Map
- **MapLibre GL JS** (open source, no API key required)
- Convert shapefiles to:
  - **GeoJSON** for small datasets (direct use)
  - **PMTiles** via `tippecanoe` for larger datasets (single static file, no tile server needed)
- Layer toggles: leases, units, wells, pipelines, county lines
- Click a feature → side panel with lease terms, operator, NRI/WI, production data (pulled from Supabase)

### Gated Downloads & Access Logging
- Files stored in **private** R2 or S3 bucket (never served directly)
- Netlify Function validates JWT, logs `{userId, dealId, file, timestamp, ip}` to Supabase `access_log` table, then returns a short-lived presigned URL (5 min TTL)
- Every tab view, file download, and map interaction logged

### Watermarked Contract Viewing
- Source PDFs in private storage
- On view request: Netlify Function fetches PDF, stamps watermark (`"{buyer name} — {timestamp} — CONFIDENTIAL"`) using `pdf-lib`, streams to `react-pdf` / `pdfjs-dist` in browser
- No download button; right-click disabled; print policy configurable
- Every view logged to `access_log`
- Note: watermarking is a deterrent + leak-investigation tool, not a technical prevention (same tradeoff commercial VDRs make)

### Admin / Internal View
- Auth-gated `/admin` route (Peak 10 employees only)
- Dashboard showing per-buyer activity: logins, tab views, file downloads, time spent
- Useful during negotiations to gauge buyer engagement

## Implementation Order

1. **Scaffold the tabbed app shell** — Vite + React + Tailwind with Peak 10 branding
2. **Wire up Clerk** — protected route tree, login page, user management
3. **Supabase schema** — `deals`, `users_deals`, `access_log` tables + seed data for one sample deal
4. **Map tab (end-to-end)** — MapLibre + PMTiles shapefile layer + click-to-detail (highest-risk piece, prove it first)
5. **Gated download flow** — R2/S3 + presigned URLs + access logging via Netlify Function
6. **Admin activity view** — internal dashboard showing per-buyer usage
7. **Remaining tabs** — LOS, type curves, lease schedule, contracts (mostly data plumbing once the shell exists)

## Open Items

- [ ] Access `p10-type-curves` repo (or screenshots) to match the dashboard aesthetic exactly
- [ ] Confirm domain setup — does Peak 10 control DNS for `peak10energy.com`?
- [ ] Confirm Netlify plan tier (Pro vs Business) based on expected concurrent deal count
- [ ] Choose auth provider (Clerk recommended, but confirm preference)
- [ ] Choose file storage provider (R2 vs S3 vs Supabase Storage)
- [ ] Determine shapefile sizes to decide GeoJSON vs PMTiles approach
- [ ] Confirm whether commercial VDR hybrid is desired for the most sensitive documents
