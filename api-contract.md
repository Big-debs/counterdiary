# CounterDiary API Contract

Base URL strategy:
- Browser default: `window.LEDGER_API_BASE_URL || '/api'`
- Local Docker with nginx proxy: `http://localhost/api/...`
- Override per environment by setting `window.LEDGER_API_BASE_URL` before app scripts load.

## `POST /api/diary`
Submit one owner diary entry.

Request JSON:
```json
{
  "anonymous_token": "LDG-ABC12345",
  "city": "Lagos",
  "lga": "Surulere",
  "diesel_price": 0,
  "staff_absent": 0,
  "spoilage_amount": 0,
  "leakage_amount": 0,
  "supplier_failure": false,
  "harassment_reported": false,
  "price_changed": false,
  "portion_reduced": false,
  "took_loss": false,
  "vent_text": ""
}
```

Response `200`:
```json
{
  "success": true,
  "entry_id": 123,
  "sentiment": "neutral"
}
```

Error `4xx/5xx`:
```json
{
  "error": "validation message or server failure"
}
```

## `GET /api/pressure/live`
Returns latest pressure snapshot by city/LGA for heatmap.

Response `200`:
```json
{
  "cities": [
    {
      "city": "Lagos",
      "lga": "Surulere",
      "pressure_score": 78,
      "diesel_price": 870,
      "staff_shortage": 25,
      "spoilage_rate": 11,
      "leakage_rate": 9,
      "harassment_reports": 4,
      "sample_size": 50
    }
  ],
  "hotspots": [
    {
      "coordinates": [3.3792, 6.5244],
      "intensity": 78,
      "severity": "high",
      "type": "pressure_hotspot",
      "city": "Lagos",
      "lga": "Surulere"
    }
  ]
}
```

## `GET /api/alerts/active`
Returns active alerts.

Query params:
- `city` (optional)
- `lga` (optional)

Response `200`:
```json
{
  "count": 2,
  "alerts": [
    {
      "alert_id": 1,
      "alert_type": "harassment",
      "severity": "critical",
      "city": "Lagos",
      "lga": "Surulere",
      "message": "..."
    }
  ]
}
```

## `GET /api/alerts/stream`
Server-Sent Events stream for live alert updates.

Event format:
```text
data: {"alerts":[...]}
```

## `GET /api/diesel/current`
Returns latest known diesel snapshot.

Response `200`:
```json
{
  "national_avg": 850,
  "cities": [
    { "name": "Lagos", "price": 870 }
  ]
}
```

## `GET /api/worker/hotspots`
Temporary placeholder endpoint.

Response `200`:
```json
{ "hotspots": [] }
```

## `GET /api/customer/complaints`
Temporary placeholder endpoint.

Response `200`:
```json
{ "complaints": [] }
```

## `POST /api/sms/subscribe`
Creates an SMS alert subscription.

Request JSON:
```json
{
  "phone": "2348031234567",
  "city": "Lagos",
  "lga": "Surulere",
  "alerts": {
    "diesel": true,
    "raids": true,
    "supplier": true,
    "spoilage": false,
    "customer": false
  }
}
```

## `POST /api/worker/reports`
Submits an anonymous worker report.

Request JSON:
```json
{
  "payment": "late",
  "status": "casual",
  "city": "Lagos",
  "whisper": "Optional free text"
}
```

Response `200`:
```json
{
  "success": true,
  "report_id": 12
}
```

## `POST /api/customer/feedback`
Submits anonymous customer feedback.

Request JSON:
```json
{
  "restaurant_id": "RES-ABC123",
  "restaurant_city": "Surulere, Lagos",
  "portion_rating": "small",
  "price_match": true,
  "will_return": false,
  "comment": "Portion was smaller than last week"
}
```

Response `200`:
```json
{
  "success": true,
  "feedback_id": 34
}
```

## `GET /api/confessions`
Returns latest confessions.

Query params:
- `limit` (optional, default `12`, max `50`)

Response `200`:
```json
{
  "confessions": [
    {
      "id": "5",
      "role": "worker",
      "city": "Lagos",
      "lga": null,
      "text": "...",
      "reactions": { "heart": 0, "share": 0, "eye": 0 },
      "timestamp": "2026-02-16T15:00:00.000Z"
    }
  ]
}
```

## `POST /api/confessions`
Creates a new anonymous confession.

Request JSON:
```json
{
  "role": "owner",
  "city": "Abuja",
  "text": "Diesel cost is crushing margins"
}
```

Response `200`:
```json
{
  "success": true,
  "confession_id": 9
}
```

## `POST /api/newsletter/subscribe`
Subscribes an email to public pulse updates.

Request JSON:
```json
{
  "email": "owner@example.com",
  "source": "public_pulse"
}
```

Response `200`:
```json
{
  "success": true,
  "subscription_id": 2,
  "email": "owner@example.com",
  "source": "public_pulse"
}
```

Response `200`:
```json
{
  "success": true,
  "subscription_id": 1,
  "phone_last_four": "4567",
  "city": "Lagos",
  "lga": "Surulere"
}
```
