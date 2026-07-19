# Neville's Song Stripper — frontend

The one-page UI: upload a file, drag the vocal-level slider, download
the mix.

For the full setup (deploying this to Vercel and wiring it to the Modal
backend), see the `README.md` at the repo root.

## Local development

```bash
npm install
npm run dev
```

Needs `NEXT_PUBLIC_STRIPPER_API_URL` set (in `.env.local`) to a deployed
Modal backend URL to actually submit songs.
