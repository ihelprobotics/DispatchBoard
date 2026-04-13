import { Board } from "../components/Board";

export default async function HomePage({
  searchParams
}: {
  searchParams?: Promise<{ mode?: string }>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const tvMode = params?.mode === "tv";
  return <Board tvMode={tvMode} />;
}
