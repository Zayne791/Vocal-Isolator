# Neville's Song Stripper — frontend

The one-page UI: paste a link, tap a button, download the mp3.

For the full setup (deploying this to Vercel and wiring it to the Modal
backend), see the `README.md` at the repo root.

## Local development

```bash
npm install
npm run dev
```

Needs `NEXT_PUBLIC_STRIPPER_API_URL` set (in `.env.local`) to a deployed
Modal backend URL to actually submit songs.
