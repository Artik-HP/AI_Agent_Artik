import "dotenv/config";

export async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const normalizedQuery = String(query || "").trim();

  if (!normalizedQuery) {
    return "Напиши запрос. Например: /youtube JavaScript Promise";
  }

  if (!apiKey) {
    return "Нет YOUTUBE_API_KEY в .env";
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/search");

  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "5");
  url.searchParams.set("key", apiKey);

  const response = await fetch(url);
  console.log("YouTube query:", normalizedQuery);
  const data = await response.json();

  if (!response.ok) {
    return data?.error?.message || `Ошибка YouTube API: ${response.status}`;
  }

  const videos = (data.items || []).map((item, index) => {
    const title = item.snippet?.title || "Без названия";
    const channel = item.snippet?.channelTitle || "Неизвестный канал";
    const videoId = item.id?.videoId;
    const link = `https://www.youtube.com/watch?v=${videoId}`;

    return [
      `${index + 1}. ${title}`,
      `Канал: ${channel}`,
      link
    ].join("\n");
  });

  if (videos.length === 0) {
    return "Видео не найдены.";
  }

  return [
    `YouTube поиск: ${normalizedQuery}`,
    "",
    ...videos
  ].join("\n\n");
}