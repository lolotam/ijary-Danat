import { createFileRoute } from "@tanstack/react-router";

import { PaymentCallbackPage } from "./portal_.payments.callback";

export const Route = createFileRoute("/portal_/payments/callback_/$preq")({
  ssr: false,
  component: PathPaymentCallbackPage,
});

function PathPaymentCallbackPage() {
  const { preq } = Route.useParams();
  return <PaymentCallbackPage paymentRequestCodeFromPath={preq} />;
}
