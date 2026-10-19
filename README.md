# Santa's Safe Catch · Zopper Christmas

In-store phone game: customers scan a QR, swipe to move Santa and catch falling phones in his big bucket.
No login. 3 lives (drop a phone or catch coal = lose a life; Zopper shield = +1 life). Speed ramps up until it's impossible to keep up.

## Files
- `index.html` – the whole game (no build step)
- `vercel.json` – static hosting settings

## Prize tiers (set per store in the QR link)
Defaults: 1000 Small gift · 1500 Bigger gift · 2000 Grand prize. Override with URL parameters:

`https://<your-site>/?t1=1000&t2=1500&t3=2000&g1=Chocolate&g2=Coffee%20mug&g3=Rs%20500%20voucher`

## Difficulty (tested with 500 simulated games per skill level)
| Player model | Reached 1000 | Reached 1500 | Reached 2000 |
|---|---|---|---|
| Perfect bot (instant reactions) | 99% | 48% | 0.8% |
| Expert human model | 98% | 37% | 0.2% |
| Good human model | 97% | 31% | 0.4% |
| Average human model | 84% | 13% | 0% |
| Casual / first-time model | 0% | 0% | 0% |

From ~55 seconds in, drops are forced far apart faster than the sleigh's top speed, so every run ends by roughly 65–75 seconds.
Tuning lives in the `CFG` block at the top of the engine script (fall speed, drop interval, `minJump` wall, points per phone).

## Deploy
Vercel → Add New → Project → import repo → Framework: Other → Deploy.
