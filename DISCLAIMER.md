# Disclaimer

**Read this before running 0dteTrader against any brokerage account.**

This document supplements — and does not replace or modify — the warranty and
liability disclaimers in the [MIT License](LICENSE). If anything here conflicts
with the license, the license controls.

## No financial advice

0dteTrader is an order-entry and market-data tool. Nothing in this software,
its documentation, its analytics (Greeks, gamma exposure, open-interest walls,
implied ranges, or any other derived figure), or its default settings is
financial, investment, legal, or tax advice, or a recommendation to buy, sell,
or hold any security or derivative. The authors and contributors are not your
broker, advisor, or fiduciary.

## This software places real orders

When connected to a live brokerage account, 0dteTrader transmits **real orders
for real money**. It is deliberately built for speed: orders can be submitted
in a single tap with server-selected strikes. That design removes friction —
and with it, opportunities to catch your own mistakes. A mis-tap, a stale
quote, a misconfigured account, or a software defect can result in an
unintended position and immediate, unrecoverable financial loss.

**Always validate against a paper (practice) account before connecting a live
account, and after every upgrade.**

## 0DTE options are among the riskiest instruments available

Zero-days-to-expiration options can lose 100% of their value within minutes.
Risks include, without limitation: total loss of premium; rapid and
unpredictable price swings; wide or vanishing bid/ask spreads; inability to
close a position at any acceptable price; early assignment and
exercise/assignment risk at expiration; and losses that can exceed your
initial outlay on certain strategies. Do not trade 0DTE options with money you
cannot afford to lose entirely.

## Software, data, and third-party risk

- This is open-source software that **may contain bugs**, including bugs that
  affect order size, direction, symbol, strike, price, or timing.
- Market data and analytics may be delayed, incomplete, inaccurate, or
  unavailable, including at the moments you most need them.
- Order execution and data depend on third-party services (including brokerage
  and data APIs) that the authors do not control and that can fail, rate-limit,
  change behavior, or return incorrect data without notice.
- If you self-host the backend, you are solely responsible for its security,
  availability, and configuration, including the safekeeping of API
  credentials.

You are responsible for reviewing the code you run, verifying every order
before and after submission, and monitoring your account directly with your
broker. Your brokerage's records — not this software's UI — are the
authoritative record of your positions and orders.

## Assumption of risk and release

By using this software you accept sole and entire responsibility for all
trading decisions and outcomes, and for compliance with your broker's terms of
service and the laws and regulations that apply to you. To the maximum extent
permitted by applicable law, you agree that the authors, copyright holders,
and contributors shall not be liable for any claim, damages, or other
liability — including trading losses, lost profits, or incidental,
consequential, special, or punitive damages — arising from or in connection
with the software or its use, even if advised of the possibility of such
damages, and you waive and release any such claims.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT.

If you do not accept these terms, do not connect this software to a brokerage
account.
