# PRE-SEGMENT REPORT: Segment 2 (Buyer Review System)

## 0. Build Gate Summary
- **Protocol Adherence**: `m0t_base_protocol_v3_1` confirmed.
- **Dependency Check**: No upstream Segment dependencies.
- **Schema Alignment**: `BuyerReview` model planned; `Profile` expansion confirmed.
- **Security Check**: Enforcing `isSeller` for submissions; `buyerId` indexing for fast stats retrieval.

## 1. Segment Parameters
- **Segment ID**: 2
- **Agent Assigned**: [A] (Sequential Execution)
- **Goal**: Implement seller-to-buyer 1-5 star rating system (Reputation).

## 2. Segment Map
- [ ] `review-service/app.js`: Implement `BuyerReview` model and routes.
- [ ] `user-service/app.js`: Implement `buyerTradingScore` profiling and event listeners.
- [ ] `api-gateway/server.js`: Proxy new review endpoints.
- [ ] `api-gateway/views/order-detail.ejs`: Add seller-side "Rate Buyer" UI.
- [ ] `api-gateway/views/profile.ejs`: Add "Buyer Reputation" display.

## 3. Reviewer Instructions
- Verify that `buyerTradingScore` is distinct from the activity-based `buyerScore`.
- Ensure `POST /buyer-review` gates against unfulfiled orders.
- Confirm stars inherit platform standard styling from `style.css`.
