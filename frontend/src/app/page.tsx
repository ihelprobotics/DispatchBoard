import { Board } from "../components/Board";

export default async function HomePage({
  searchParams
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : undefined;
  const mode = typeof params?.mode === "string" ? params.mode : undefined;
  const tvMode = mode === "tv";
  return <Board tvMode={tvMode} />;
}
