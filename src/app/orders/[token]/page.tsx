import Tracking from "@/components/tracking";

export default async function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Tracking token={token} />;
}
