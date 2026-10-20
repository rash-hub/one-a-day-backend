# One a Day: backend

A small Express API. It reads `data.json` when it starts and saves back to it after every change.

## Run

```bash
npm install
npm start
```

Use `npm run dev` if you want it to restart when you edit files. It listens on port 3001. You can change that with the `PORT` environment variable. `DATA_FILE` and `CORS_ORIGIN` can also be set if you need them.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/api/login` | Send `{nickname, pin}`. Makes the account if it's new, and returns a token. |
| GET | `/api/today` | Today's tip and question. The right answer is only included once you've answered. |
| POST | `/api/answer` | Send `{choice}` as 0, 1 or 2. Checks it, gives points, updates the streak. |
| GET | `/api/leaderboard` | Top 10 plus your own rank. |
| GET | `/api/health` | `{"ok":true}` |

Everything except login and health needs an `Authorization: Bearer <token>` header.

## data.json

It has four parts: `users`, `sessions`, `attempts` (one row per person per day) and `questions`. Each question has a tip, the question, three options and the index of the right one.

To add a question, add another item to `questions`. The question for a given day is `questions[dayNumber % questions.length]`.
