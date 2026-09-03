import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import carrotLogo from "./assets/carrot-logo.png";
import carrotAvatar from "./assets/carrot-avatar.png";
import "./styles.css";

const DEFAULT_TOPICS = ["Chưa phân loại"];
const TOPIC_STORAGE = "rot_custom_topics_v1";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

const cleanText = (value) => String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const cap = (value) => { const text = cleanText(value); return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""; };
const normalizeWord = (value) => cleanText(value).toLowerCase();
const formatIpa = (value) => { const text = cleanText(value).replace(/^\/+|\/+$/g, ""); return text ? `/${text}/` : ""; };
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const FETCH_TIMEOUT_MS = 12000;
async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function saveUserVocab(supabaseClient, payload) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data: sessionData } = await supabaseClient.auth.getSession();
      const sessionUser = sessionData?.session?.user;
      if (!sessionUser) throw new Error("not_authenticated");
      const safePayload = { ...payload, user_id: sessionUser.id };

      const rpcResult = await supabaseClient.rpc("save_user_vocab", { vocab_payload: safePayload });
      if (!rpcResult.error) return rpcResult.data;

      const rpcMessage = cleanText(rpcResult.error.message || "");
      if (/function .*save_user_vocab.*does not exist|could not find the function|schema cache/i.test(rpcMessage)) {
        const fallback = await supabaseClient
          .from("user_vocab")
          .upsert(safePayload, { onConflict: "user_id,word_id" })
          .select()
          .single();
        if (!fallback.error) return fallback.data;
        throw fallback.error;
      }
      throw rpcResult.error;
    } catch (error) {
      lastError = error;
      const message = cleanText(error?.message || error || "").toLowerCase();
      const transient = /failed to fetch|networkerror|load failed|timeout|abort|signal is aborted|fetch/i.test(message);
      if (!transient || attempt === 1) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error("save_failed");
}

function authErrorMessage(error) {
  const raw = cleanText(error?.message || error || "");
  const lower = raw.toLowerCase();
  if (lower.includes("email rate limit exceeded") || lower.includes("rate limit")) {
    return "Supabase đang giới hạn số email gửi ra. Nếu bạn không cần xác nhận email, hãy vào Supabase → Authentication → Providers → Email và tắt Confirm email; nếu cần xác nhận email, hãy chờ giới hạn được reset hoặc cấu hình SMTP riêng.";
  }
  if (lower.includes("invalid login credentials")) return "Gmail/tên đăng nhập hoặc mật khẩu không đúng.";
  if (lower.includes("email not confirmed")) return "Email chưa được xác nhận. Hãy kiểm tra hộp thư và thư rác rồi xác nhận email.";
  if (lower.includes("user already registered")) return "Email này đã được đăng ký. Hãy đăng nhập bằng Gmail/email hoặc tên đăng nhập.";
  if (lower.includes("password should be at least")) return "Mật khẩu chưa đủ độ dài theo yêu cầu của Supabase.";
  if (lower.includes("username") && lower.includes("used")) return "Tên đăng nhập này đã được sử dụng.";
  return raw || "Không thể thực hiện. Hãy kiểm tra thông tin và thử lại.";
}


async function translate(text) {
  const q = cleanText(text);
  if (!q) return "";
  const cacheKey = `rot_trans_${q.toLowerCase()}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;
  } catch {}

  const providers = [
    async () => {
      const response = await fetchWithTimeout(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|vi`, {}, 9000);
      if (!response.ok) throw new Error("translation_failed");
      const data = await response.json();
      return cleanText(data?.responseData?.translatedText);
    },
    async () => {
      const response = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t&q=${encodeURIComponent(q)}`, {}, 9000);
      if (!response.ok) throw new Error("translation_failed");
      const data = await response.json();
      return cleanText(Array.isArray(data?.[0]) ? data[0].map(row => row?.[0]).filter(Boolean).join(" ") : "");
    },
  ];

  for (const provider of providers) {
    try {
      const result = await provider();
      if (result && !/^\s*(null|undefined)\s*$/i.test(result)) {
        try { localStorage.setItem(cacheKey, result); } catch {}
        return result;
      }
    } catch {}
  }
  return "Chưa có bản dịch tự động";
}

function shortMeaning(value) {
  const text = cleanText(value)
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "Chưa có nghĩa";
  // Keep the first concise sense, but do not split ordinary Vietnamese phrases
  // at commas/semicolons when the translation itself is already short.
  const candidates = text.split(/(?:\s*[;]\s*|\s+\/\s+)/).map(part => part.replace(/[.!?]+$/, "").trim()).filter(Boolean);
  const first = candidates[0] || text;
  return first.length > 70 ? `${first.slice(0, 67).trim()}…` : first;
}

async function translateShortMeaning(word, definition = "") {
  const direct = await translate(word);
  if (direct && direct !== "Chưa có bản dịch tự động") return shortMeaning(direct).toLowerCase();
  const fallback = await translate(definition);
  return fallback && fallback !== "Chưa có bản dịch tự động" ? shortMeaning(fallback).toLowerCase() : "Chưa có nghĩa";
}

async function fetchWordSuggestions(text) {
  const q = cleanText(text);
  if (!q) return [];
  try {
    const response = await fetchWithTimeout(`https://api.datamuse.com/sug?s=${encodeURIComponent(q)}&lang=en&max=8`);
    if (!response.ok) return [];
    const data = await response.json();
    return [...new Set((Array.isArray(data) ? data : []).map(item => cleanText(item.word)).filter(Boolean))].slice(0, 8);
  } catch {
    return [];
  }
}

async function fetchDictionary(word) {
  const encoded = encodeURIComponent(word);
  const providers = [
    {
      name: "freedictionaryapi",
      url: `https://freedictionaryapi.com/api/v1/entries/en/${encoded}`,
      parse: (data) => {
        const entries = Array.isArray(data?.entries) ? data.entries : [];
        const first = entries[0] || {};
        const senses = entries.flatMap((entry) => Array.isArray(entry.senses) ? entry.senses : []);
        const definition = cleanText((senses[0] || {}).definition);
        const examples = senses.flatMap((sense) => Array.isArray(sense.examples) ? sense.examples.map(cleanText) : []).filter(Boolean);
        const synonyms = senses.flatMap((sense) => Array.isArray(sense.synonyms) ? sense.synonyms.map(cleanText) : []).filter(Boolean);
        const pronunciations = entries.flatMap((entry) => Array.isArray(entry.pronunciations) ? entry.pronunciations : []);
        const ipa = pronunciations.find((p) => p?.type === "ipa" && p?.text)?.text || pronunciations.find((p) => p?.text)?.text || "";
        const audio = pronunciations.find((p) => p?.audio)?.audio || "";
        return {
          word: cleanText(data?.word || word),
          phonetic: formatIpa(ipa), audio,
          partOfSpeech: cap(first.partOfSpeech || ""),
          definition,
          examples: [...new Set(examples)].slice(0, 3),
          synonyms: [...new Set(synonyms)].slice(0, 8),
        };
      },
    },
    {
      name: "dictionaryapi",
      url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encoded}`,
      parse: (data) => {
        const entry = data?.[0] || {};
        const meanings = entry.meanings || [];
        const first = meanings[0] || {};
        const definition = cleanText(first.definitions?.[0]?.definition);
        const examples = meanings.flatMap((m) => (m.definitions || []).map((d) => cleanText(d.example)).filter(Boolean));
        const phonetic = entry.phonetic || entry.phonetics?.find((p) => p.text)?.text || "";
        const audio = entry.phonetics?.find((p) => p.audio)?.audio || "";
        const partOfSpeech = first.partOfSpeech || meanings.find((m) => m.partOfSpeech)?.partOfSpeech || "";
        const synonyms = meanings.flatMap((m) => m.synonyms || []);
        return { word: cleanText(entry.word || word), phonetic: formatIpa(phonetic), audio, partOfSpeech: cap(partOfSpeech), definition, examples: [...new Set(examples)].slice(0, 3), synonyms: [...new Set(synonyms)].slice(0, 8) };
      },
    },
    {
      name: "suvankar",
      url: `https://api.suvankar.cc/dictionaryapi/v1/definitions/en/${encoded}?compact=true`,
      parse: (data) => {
        const meanings = Array.isArray(data?.meanings) ? data.meanings : [];
        const first = meanings[0] || {};
        const definitions = Array.isArray(first.definitions) ? first.definitions.map(cleanText).filter(Boolean) : [];
        const examples = Array.isArray(first.examples) ? first.examples.map(cleanText).filter(Boolean) : [];
        const synonyms = meanings.flatMap((m) => Array.isArray(m.synonyms) ? m.synonyms.map(cleanText) : []).filter(Boolean);
        return { word: cleanText(data?.word || word), phonetic: formatIpa(data?.ipa || ""), audio: "", partOfSpeech: cap(first.partOfSpeech || ""), definition: definitions[0] || "", examples: [...new Set(examples)].slice(0, 3), synonyms: [...new Set(synonyms)].slice(0, 8) };
      },
    },
  ];

  let sawNotFound = false;
  let lastError = null;
  for (const provider of providers) {
    try {
      const response = await fetchWithTimeout(provider.url, {}, 9000);
      if (response.status === 404) { sawNotFound = true; continue; }
      if (!response.ok) { lastError = new Error(`${provider.name}:${response.status}`); continue; }
      const data = await response.json();
      const parsed = provider.parse(data);
      if (parsed?.definition) return parsed;
    } catch (error) {
      lastError = error;
    }
  }
  if (sawNotFound && !lastError) throw new Error("not_found");
  const wrapped = new Error("dictionary_unavailable");
  wrapped.cause = lastError;
  throw wrapped;
}

async function fetchCollocations(word) {
  try {
    const requests = [
      `https://api.datamuse.com/words?rel_jjb=${encodeURIComponent(word)}&max=5`,
      `https://api.datamuse.com/words?rel_jja=${encodeURIComponent(word)}&max=5`,
      `https://api.datamuse.com/words?rel_trg=${encodeURIComponent(word)}&max=5`,
    ];
    const results = await Promise.all(requests.map(async (url) => {
      try {
        const response = await fetchWithTimeout(url);
        return response.ok ? await response.json() : [];
      } catch {
        return [];
      }
    }));
    const words = results.flat().map((item) => cleanText(item?.word)).filter(Boolean);
    return [...new Set(words)].filter((item) => item.toLowerCase() !== word.toLowerCase()).slice(0, 8).map((item) => `${item} ${word}`);
  } catch { return []; }
}

function normalizeDetailRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ en: cleanText(row?.en), vi: cleanText(row?.vi) }))
    .filter((row) => row.en);
}

async function enrichWord(word, forceRefresh = false) {
  const key = `rot_dict_${normalizeWord(word)}`;
  if (!forceRefresh) { try { const cached = localStorage.getItem(key); if (cached) return JSON.parse(cached); } catch {} }
  let base;
  try {
    base = await fetchDictionary(word);
  } catch (error) {
    if (error?.message === "not_found") throw error;
    // The dictionary is an enrichment service, not a prerequisite for saving.
    // If it is temporarily unavailable, keep the word and let the user fill
    // in details later instead of blocking the save operation.
    return {
      id: normalizeWord(word), word, meaning: "Chưa có dữ liệu nghĩa",
      partOfSpeech: "Chưa xác định", ipa: "", audio: "",
      collocations: [], examples: [], definitionEn: "", synonyms: [],
      learnedAt: new Date().toISOString(), reps: 0,
      _enrichmentUnavailable: true,
    };
  }
  const meaning = await translateShortMeaning(base.word, base.definition);
  const exampleRows = normalizeDetailRows(await Promise.all(base.examples.map(async (example) => ({ en: example, vi: await translate(example) }))));
  const rawCollocations = await fetchCollocations(base.word);
  const collocations = normalizeDetailRows(await Promise.all(rawCollocations.map(async (phrase) => ({ en: phrase, vi: await translate(phrase) }))));
  const result = { id: normalizeWord(base.word), word: base.word, meaning: shortMeaning(meaning), partOfSpeech: base.partOfSpeech || "Chưa xác định", ipa: base.phonetic || "", audio: base.audio || "", collocations, examples: exampleRows, definitionEn: cleanText(base.definition), synonyms: Array.isArray(base.synonyms) ? [...new Set(base.synonyms.map(cleanText).filter(Boolean))].slice(0, 8) : [], learnedAt: new Date().toISOString(), reps: 0 };
  try { localStorage.setItem(key, JSON.stringify(result)); } catch {}
  return result;
}

function shuffle(items) { return [...items].sort(() => Math.random() - 0.5); }
function buildQuestions(vocab, count) {
  const pool = vocab.filter(Boolean);
  if (!pool.length || count <= 0) return [];

  const uniqueBy = (items, key) => {
    const seen = new Set();
    return items.filter((item) => {
      const value = cleanText(key(item)).toLowerCase();
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  };

  const questions = [];
  const candidates = [];
  for (const item of shuffle(pool)) {
    const meaning = cleanText(item.meaning);
    const wordDistractors = uniqueBy(pool.filter(v => v.id !== item.id).map(v => v.meaning), v => v).filter(v => v !== meaning);
    if (meaning && wordDistractors.length >= 3) candidates.push({
      type: "word",
      prompt: item.word,
      label: "Chọn nghĩa tiếng Việt đúng cho từ:",
      answer: meaning,
      distractors: wordDistractors.slice(0, 6),
      wordId: item.id,
    });

    for (const phrase of (item.collocations || []).slice(0, 2)) {
      const answer = cleanText(phrase.vi);
      if (!answer) continue;
      const distractors = uniqueBy(pool.flatMap(v => v.collocations || []).filter(p => p.en !== phrase.en).map(p => p.vi), v => v).filter(v => v !== answer);
      if (distractors.length >= 3) candidates.push({ type: "phrase", prompt: phrase.en, label: "Chọn nghĩa tiếng Việt đúng cho cụm từ:", answer, distractors: distractors.slice(0, 6), wordId: item.id });
      break;
    }

    for (const example of (item.examples || []).slice(0, 2)) {
      const answer = cleanText(example.vi);
      if (!answer) continue;
      const distractors = uniqueBy(pool.flatMap(v => v.examples || []).filter(e => e.en !== example.en).map(e => e.vi), v => v).filter(v => v !== answer);
      if (distractors.length >= 3) candidates.push({ type: "sentence", prompt: example.en, label: "Chọn nghĩa tiếng Việt đúng cho câu:", answer, distractors: distractors.slice(0, 6), wordId: item.id });
      break;
    }

    const sentence = cleanText(item.examples?.[0]?.en) || `I really like ${item.word}.`;
    const escapedWord = escapeRegExp(item.word);
    if (new RegExp(`\\b${escapedWord}\\b`, "i").test(sentence)) {
      const answer = item.word;
      const distractors = uniqueBy(pool.filter(v => v.id !== item.id).map(v => v.word), v => v).filter(v => v.toLowerCase() !== answer.toLowerCase());
      if (distractors.length >= 3) candidates.push({ type: "fill", prompt: sentence.replace(new RegExp(`\\b${escapedWord}\\b`, "i"), "_____"), label: "Chọn từ điền vào chỗ trống:", answer, distractors: distractors.slice(0, 6), wordId: item.id });
    }
  }

  const shuffled = shuffle(candidates);
  const usedKeys = new Set();
  for (const candidate of shuffled) {
    if (questions.length >= count) break;
    const key = `${candidate.type}|${candidate.wordId}|${candidate.prompt}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    questions.push({ ...candidate, choices: shuffle([candidate.answer, ...shuffle(candidate.distractors).slice(0, 3)]) });
  }

  return questions;
}

function Header({ page, setPage, user, onAccount }) {
  return <header className="topbar">
    <div className="brand-mini" onClick={() => setPage("home")}><img src={carrotAvatar} alt="Rốt" /><span>Học tiếng Anh cùng Rốt</span></div>
    <nav>
      <button className={page === "home" ? "active" : ""} onClick={() => setPage("home")}>Trang chủ</button>
      <button className={page === "vocab" ? "active" : ""} onClick={() => setPage("vocab")}>Từ vựng</button>
      <button className={page === "review" ? "active" : ""} onClick={() => setPage("review")}>Ôn tập</button>
      <button className={page === "link" ? "active" : ""} onClick={() => setPage("link")}>Liên kết</button>
      <button className={page === "account" ? "active" : ""} onClick={onAccount}>Tài khoản</button>
    </nav>
  </header>;
}

function Home({ setPage, user, profileUsername }) {
  return <section className="home-card">
    <img className="hero-carrot" src={carrotLogo} alt="Cà rốt" />
    <div className="eyebrow">HỌC TIẾNG ANH MỖI NGÀY</div>
    <h1>Học tiếng Anh<br />cùng Rốt</h1>
    <p>{user ? `Xin chào ${profileUsername || user.user_metadata?.username || "bạn"}.` : "Đăng nhập để lưu từ vựng và ôn tập trên mọi lần mở ứng dụng."}</p>
    <div className="home-actions">
      <button className="primary" onClick={() => setPage("vocab")}>＋ Thêm từ vựng</button>
      <button className="secondary" onClick={() => setPage("review")}>▶ Ôn tập ngay</button>
    </div>
  </section>;
}

function VocabPage({ vocab, setVocab, user, setPage, vocabError }) {
  const [word, setWord] = useState(""); const [suggestions, setSuggestions] = useState([]); const [showSuggestions, setShowSuggestions] = useState(false); const [detail, setDetail] = useState(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [query, setQuery] = useState(""); const [newTopic, setNewTopic] = useState(""); const [customTopics, setCustomTopics] = useState([]);
  useEffect(() => {
    if (!user) { setCustomTopics([]); return; }
    try {
      const saved = JSON.parse(localStorage.getItem(`${TOPIC_STORAGE}_${user.id}`) || "[]");
      setCustomTopics(Array.isArray(saved) ? saved : []);
    } catch { setCustomTopics([]); }
  }, [user]);
  const topics = useMemo(() => {
    const fromWords = vocab.map(item => cleanText(item.topic)).filter(t => t && t !== "Chưa phân loại");
    return [...new Set([...DEFAULT_TOPICS, ...customTopics, ...fromWords])];
  }, [vocab, customTopics]);
  useEffect(() => {
    const q = cleanText(word);
    if (q.length < 1) { setSuggestions([]); return undefined; }
    let alive = true;
    const timer = setTimeout(async () => {
      const next = await fetchWordSuggestions(q);
      if (alive) setSuggestions(next.filter(item => normalizeWord(item) !== q.toLowerCase()));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [word, user]);

  const createTopic = (event) => {
    event.preventDefault();
    if (!user) { setError("Bạn cần đăng nhập để tạo chủ đề."); return; }
    const name = cleanText(newTopic);
    if (!name || name === "Chưa phân loại") return;
    const exists = topics.some(topic => topic.toLowerCase() === name.toLowerCase());
    if (exists) { setError("Chủ đề này đã tồn tại."); return; }
    const next = [...customTopics, name];
    setCustomTopics(next);
    if (user) localStorage.setItem(`${TOPIC_STORAGE}_${user.id}`, JSON.stringify(next));
    setNewTopic(""); setError("");
  };

  const addWord = async (event) => {
    event.preventDefault(); setError(""); setNotice("");
    if (!user) { setError("Bạn cần đăng nhập để lưu từ vựng. Bạn vẫn có thể xem tra cứu, nhưng từ sẽ không được lưu khi chưa đăng nhập."); return; }
    const clean = normalizeWord(word); if (!clean) { setError("Hãy nhập một từ tiếng Anh."); return; } setLoading(true); setShowSuggestions(false);
    try {
      const data = await enrichWord(clean);
      const existing = vocab.find(item => item.id === data.id);
      const payload = {
        user_id: user.id, word_id: data.id, word: data.word, meaning: data.meaning,
        part_of_speech: data.partOfSpeech, ipa: data.ipa, audio: data.audio,
        collocations: data.collocations || [], examples: data.examples || [],
        definition_en: data.definitionEn || "", synonyms: data.synonyms || [],
        learned_at: existing?.learnedAt || data.learnedAt, reps: existing?.reps || 0,
        topic: existing?.topic || "Chưa phân loại",
      };
      if (!supabase) throw new Error("supabase_missing");
      const saved = await saveUserVocab(supabase, payload);
      if (!saved) throw new Error("save_empty");
      const normalized = rowToVocab(saved);
      setVocab(current => current.some(item => item.id === normalized.id) ? current.map(item => item.id === normalized.id ? normalized : item) : [normalized, ...current]);
      setDetail(normalized); setWord(""); setSuggestions([]);
      if (data._enrichmentUnavailable) setNotice("Đã lưu từ. Dữ liệu tra cứu chưa phản hồi lúc này; bạn có thể bấm “Tra cứu lại” trong phần chi tiết.");
    } catch (e) {
      const raw = cleanText(e?.message || e || "");
      if (e?.message === "supabase_missing") setError("Chưa cấu hình Supabase. Hãy kiểm tra biến VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY.");
      else if (e?.message === "not_found") setError("Không tìm thấy từ này trong từ điển. Hãy chọn một gợi ý bên dưới hoặc kiểm tra chính tả.");
      else if (/row-level security|permission denied|violates row-level security/i.test(raw)) setError("Supabase đang từ chối lưu từ. Hãy chạy lại supabase/schema.sql rồi thử lại.");
      else if (/duplicate key|unique constraint/i.test(raw)) setError("Từ này đã có trong kho. Nếu bạn muốn cập nhật thông tin, hãy thử lại sau vài giây.");
      else if (/save_empty/i.test(raw)) setError("Supabase không trả về dữ liệu sau khi lưu. Hãy thử lại.");
      else if (/function .*save_user_vocab.*does not exist|could not find the function/i.test(raw)) setError("Không thể lưu từ vì database chưa cập nhật hàm lưu. Hãy chạy lại supabase/schema.sql trên Supabase.");
      else if (/not_authenticated/i.test(raw)) setError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại rồi thử lưu từ.");
      else if (/dictionary_unavailable/i.test(raw)) setError("Dịch vụ tra cứu từ đang tạm thời không phản hồi. Từ vẫn có thể được lưu lại; hãy thử lại phần tra cứu sau.");
      else if (/failed to fetch|networkerror|load failed|abort|signal is aborted|fetch/i.test(raw)) setError("Kết nối mạng hoặc Supabase đang gián đoạn. Hãy kiểm tra kết nối rồi thử lại.");
      else setError(raw ? `Không thể lưu từ: ${raw}` : "Không thể lưu từ. Hãy kiểm tra kết nối mạng, Supabase và tài khoản rồi thử lại.");
    }
    finally { setLoading(false); }
  };
  const updateTopic = async (item, topic) => {
    if (!user || !supabase) return;
    setError("");
    const { data: saved, error: updateError } = await supabase.from("user_vocab").update({ topic }).eq("user_id", user.id).eq("word_id", item.id).select().single();
    if (updateError) { setError("Không thể lưu chủ đề. Hãy thử lại."); return; }
    const normalized = rowToVocab(saved);
    setVocab(current => current.map(v => v.id === normalized.id ? normalized : v));
    if (detail?.id === normalized.id) setDetail(normalized);
  };
  const refreshWord = async (item) => {
    if (!user || !supabase) return;
    try {
      const data = await enrichWord(item.word, true);
      const payload = {
        user_id: user.id, word_id: data.id, word: data.word, meaning: data.meaning,
        part_of_speech: data.partOfSpeech, ipa: data.ipa, audio: data.audio,
        collocations: data.collocations || [], examples: data.examples || [],
        definition_en: data.definitionEn || "", synonyms: data.synonyms || [],
        learned_at: item.learnedAt, reps: item.reps || 0, topic: item.topic || "Chưa phân loại",
      };
      const saved = await saveUserVocab(supabase, payload);
      if (!saved) throw new Error("save_empty");
      const normalized = rowToVocab(saved);
      setVocab(current => current.map(v => v.id === normalized.id ? normalized : v));
      setDetail(normalized);
      setError("");
      setNotice("Đã cập nhật dữ liệu tra cứu cho từ này.");
    } catch (e) {
      setError(e?.message === "not_found" ? "Không tìm thấy từ này trong từ điển." : "Chưa thể tra cứu lại lúc này. Hãy thử lại sau.");
    }
  };

  const removeWord = async (item) => {
    if (!user || !supabase) return;
    const { error: deleteError } = await supabase.from("user_vocab").delete().eq("user_id", user.id).eq("word_id", item.id);
    if (deleteError) { setError("Không thể xóa từ lúc này. Hãy thử lại."); return; }
    setVocab(current => current.filter(v => v.id !== item.id));
    if (detail?.id === item.id) setDetail(null);
  };
  const filtered = useMemo(() => { const q = cleanText(query).toLowerCase(); return q ? vocab.filter(item => item.word.toLowerCase().includes(q) || item.meaning.toLowerCase().includes(q)) : vocab; }, [vocab, query]);
  return <section className="page-card">
    <div className="page-heading"><div><div className="eyebrow">KHO CÁ NHÂN</div><h2>Từ vựng</h2><p>Nhập từ tiếng Anh để lấy nghĩa tiếng Việt, từ loại, phiên âm, cụm từ và ví dụ.</p></div><div className="count-badge">{vocab.length} từ đã lưu</div></div>
    {!user && <div className="login-notice">🔐 Muốn lưu từ và dùng ôn tập, hãy <button onClick={() => setPage("account")}>đăng nhập / tạo tài khoản</button>.</div>}
    <form className="add-form" onSubmit={addWord}><div className="word-input-wrap"><input value={word} onChange={e => { setWord(e.target.value); setShowSuggestions(true); }} onFocus={() => setShowSuggestions(true)} onBlur={() => setTimeout(() => setShowSuggestions(false), 150)} placeholder="Ví dụ: environment" aria-label="Từ tiếng Anh" autoComplete="off" />{showSuggestions && suggestions.length > 0 && <div className="word-suggestions" role="listbox">{suggestions.map(item => <button type="button" key={item} onMouseDown={e => e.preventDefault()} onClick={() => { setWord(item); setSuggestions([]); setShowSuggestions(false); }}>{item}</button>)}</div>}</div><button className="primary" disabled={loading || !user}>{loading ? "Đang lưu..." : "＋ Thêm từ"}</button></form>
    {vocabError && <div className="error-box">{vocabError}</div>}
    {error && <div className="error-box">{error}</div>}
    {notice && <div className="notice-box">{notice}</div>}
    <div className="topic-manager">
      <div><h3>Chủ đề của bạn</h3><p className="muted">Tự đặt tên chủ đề để phân loại từ theo cách bạn muốn.</p></div>
      <form onSubmit={createTopic} className="topic-create"><input value={newTopic} onChange={e => setNewTopic(e.target.value)} placeholder="Ví dụ: Từ vựng IELTS Writing" /><button className="secondary" disabled={!user}>＋ Tạo chủ đề</button></form>
      <div className="topic-chips">{topics.map(topic => <span className="topic-chip" key={topic}>{topic}</span>)}</div>
    </div>
    <div className="list-toolbar"><div><h3>Từ đã lưu</h3><span className="muted">Chọn chủ đề ngay trên từng từ.</span></div><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm từ hoặc nghĩa..." /></div>
    <div className="vocab-list">{filtered.length === 0 && <div className="empty">{user ? "Chưa có từ nào. Hãy thêm từ đầu tiên ở phía trên." : "Đăng nhập để xem kho từ cá nhân."}</div>}{filtered.map(item => <React.Fragment key={item.id}><div className={`vocab-row ${detail?.id === item.id ? "selected" : ""}`} role="button" tabIndex={0} aria-expanded={detail?.id === item.id} aria-label={`Xem chi tiết từ ${item.word}`} onClick={() => setDetail(current => current?.id === item.id ? null : item)} onKeyDown={e => { if (e.target.closest("select,button,input")) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetail(current => current?.id === item.id ? null : item); } }}><div className="word-main"><b>{item.word}</b><span>{item.partOfSpeech}</span></div><div className="word-meaning">{item.meaning || "Chưa có nghĩa"}</div><div className="word-ipa">{item.ipa || "—"}</div><select className="topic-select" value={item.topic || "Chưa phân loại"} onClick={e => e.stopPropagation()} onChange={e => updateTopic(item, e.target.value)}>{topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}</select><span className="arrow">{detail?.id === item.id ? "⌄" : "›"}</span></div>{detail?.id === item.id && <WordDetail item={detail} onClose={() => setDetail(null)} onDelete={() => removeWord(detail)} onRefresh={refreshWord} />}</React.Fragment>)}</div>
  </section>;
}

function WordDetail({ item, onClose, onDelete, onRefresh }) {
  const [translated, setTranslated] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = [...(item.collocations || []), ...(item.examples || [])];
      const values = {};
      for (const row of rows) {
        const existing = cleanText(row?.vi);
        values[row.en] = existing && existing !== "Chưa có bản dịch tự động" ? existing : await translate(row.en);
      }
      if (alive) setTranslated(values);
    })();
    return () => { alive = false; };
  }, [item]);
  const refresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try { await onRefresh(item); } finally { setRefreshing(false); }
  };
  return <div className="detail-panel">
    <div className="detail-head">
      <div><h3>{item.word}</h3><div className="detail-subtitle">Thông tin từ vựng</div></div>
      <div className="detail-actions"><button className="refresh-btn" onClick={refresh} disabled={refreshing}>{refreshing ? "Đang tra..." : "↻ Tra cứu lại"}</button><button className="icon-btn" onClick={onClose}>×</button>{onDelete && <button className="delete-btn" onClick={onDelete}>Xóa từ</button>}</div>
    </div>
    <div className="detail-facts">
      <div><span>Từ loại</span><b>{item.partOfSpeech || "Chưa xác định"}</b></div>
      <div><span>Phiên âm</span><b>{item.ipa || "—"}</b></div>
      <div className="detail-meaning"><span>Nghĩa</span><b>{shortMeaning(item.meaning)}</b></div>
    </div>
    <div className="detail-topic"><b>Chủ đề:</b> {item.topic || "Chưa phân loại"}</div>
    {item.audio && <button className="audio-btn" onClick={() => { const audio = new Audio(item.audio); audio.play().catch(() => {}); }}>🔊 Nghe phát âm</button>}
    <div className="detail-grid">
      <div><h4>Cụm từ liên quan</h4>{item.collocations?.length ? item.collocations.map(row => <div className="hover-line" key={row.en}><b>{row.en}</b><small>{translated[row.en] || "Đang dịch..."}</small></div>) : <div className="muted">Chưa lấy được cụm từ tự động.</div>}</div>
      <div><h4>Ví dụ liên quan</h4>{item.examples?.length ? item.examples.map(row => <div className="hover-line example" key={row.en}><b>{row.en}</b><small>{translated[row.en] || "Đang dịch..."}</small></div>) : <div className="muted">Chưa có ví dụ.</div>}</div>
    </div>
    {item.definitionEn && <div className="english-definition"><b>Giải thích tiếng Anh:</b> {item.definitionEn}</div>}
  </div>;
}

function ReviewPage({ vocab, user, setPage }) {
  const [questions, setQuestions] = useState([]); const [index, setIndex] = useState(0); const [choice, setChoice] = useState(null); const [started, setStarted] = useState(false); const [score, setScore] = useState(0); const [count, setCount] = useState(10); const [reviewMode, setReviewMode] = useState("random"); const [reviewTopic, setReviewTopic] = useState(""); const [startError, setStartError] = useState(""); const [finished, setFinished] = useState(false); const [finalScore, setFinalScore] = useState(0);
  const current = questions[index]; const answered = choice !== null;
  const topics = [...new Set(vocab.map(v => v.topic).filter(t => t && t !== "Chưa phân loại"))].sort((a,b) => a.localeCompare(b, "vi"));
  const start = () => {
    const pool = reviewMode === "topic" ? vocab.filter(v => v.topic === reviewTopic) : vocab;
    const built = buildQuestions(pool, Number(count));
    setQuestions(built); setIndex(0); setChoice(null); setScore(0); setFinalScore(0); setFinished(false); setStartError(""); setStarted(built.length > 0);
    if (!built.length && pool.length) setStartError("Kho từ chưa đủ dữ liệu để tạo câu hỏi 4 đáp án. Hãy thêm vài từ khác có nghĩa, cụm từ hoặc ví dụ rồi thử lại.");
  };
  const answer = selected => { if (answered) return; setChoice(selected); if (selected === current.answer) setScore(s => s + 1);  };
  const next = () => {
    if (index + 1 >= questions.length) {
      setFinalScore(score + (choice === current.answer ? 1 : 0));
      setStarted(false);
      setFinished(true);
      return;
    }
    setIndex(i => i + 1); setChoice(null);
  };
  if (!user) return <section className="page-card review-start"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">ÔN TẬP</div><h2>Ôn tập từ đã học</h2><p>Bạn cần đăng nhập để rốt lấy đúng những từ bạn đã lưu và tạo bộ câu hỏi cá nhân.</p><button className="primary large" onClick={() => setPage("account")}>🔐 Đăng nhập để ôn tập</button></section>;
  if (finished) return <section className="page-card review-start"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">HOÀN THÀNH ÔN TẬP</div><h2>Giỏi lắm! 🥕</h2><p>Bạn vừa hoàn thành một lượt ôn tập.</p><div className="review-stats"><b>{finalScore}/{questions.length}</b><span>câu đúng</span></div><button className="primary large" onClick={() => { setFinished(false); setIndex(0); setChoice(null); }}>▶ Chọn bộ câu hỏi mới</button></section>;
  if (!started) return <section className="page-card review-start"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">ÔN TẬP</div><h2>Ôn tập từ đã học</h2><p>Ôn tập <b>không giới hạn số lần</b>. Bạn có thể tạo bộ mới bất cứ lúc nào: ngẫu nhiên từ toàn bộ kho hoặc chỉ ôn theo một chủ đề.</p><div className="review-stats"><b>{vocab.length}</b><span>từ đã lưu</span></div>{vocab.length === 0 && <div className="error-box">Hãy thêm ít nhất 1 từ ở mục Từ vựng trước khi bắt đầu ôn tập.</div>}<div className="review-mode-picker"><span>Phạm vi ôn tập</span><div className="mode-buttons"><button className={reviewMode === "random" ? "selected" : ""} onClick={() => setReviewMode("random")}>🎲 Ngẫu nhiên từ đã thêm</button><button className={reviewMode === "topic" ? "selected" : ""} onClick={() => setReviewMode("topic")}>🏷️ Ôn theo chủ đề</button></div>{reviewMode === "topic" && <select value={reviewTopic} onChange={e => setReviewTopic(e.target.value)}><option value="">-- Chọn chủ đề --</option>{topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}</select>}{reviewMode === "topic" && !topics.length && <small className="muted">Bạn chưa tạo chủ đề nào. Hãy tạo chủ đề trong mục Từ vựng.</small>}</div><div className="count-picker"><span>Số câu mỗi lượt</span>{[10,20,30].map(n => <button key={n} className={count === n ? "selected" : ""} onClick={() => setCount(n)}>{n}</button>)}</div>{startError && <div className="error-box">{startError}</div>}<button className="primary large" disabled={!vocab.length || (reviewMode === "topic" && !reviewTopic)} onClick={start}>▶ Bắt đầu ôn tập</button></section>;
  const correct = choice === current.answer;
  return <section className="page-card quiz-card"><div className="quiz-top"><span>Câu {index + 1}/{questions.length}</span><b>Điểm: {score}</b><button className="secondary small" onClick={() => setStarted(false)}>Thoát</button></div><div className="progress"><span style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div><div className="question-label">{current.label}</div><div className="question-prompt">{current.prompt}</div><div className="choices">{current.choices.map((option, i) => { const letter = String.fromCharCode(65 + i); const isCorrect = option === current.answer; const isChosen = option === choice; return <button key={`${option}-${i}`} className={`choice ${answered ? (isCorrect ? "correct" : isChosen ? "wrong" : "muted-choice") : ""}`} onClick={() => answer(option)}><b>{letter}.</b><span>{option}</span></button>; })}</div>{answered && <div className={`feedback ${correct ? "good" : "bad"}`}><b>{correct ? "✓ Chính xác!" : `✗ Đáp án đúng: ${current.answer}`}</b><p>{current.type === "fill" ? `Từ “${current.answer}” phù hợp nhất với ngữ cảnh của câu.` : `Đây là nghĩa phù hợp nhất với nội dung đang được hỏi.`}</p><button className="primary" onClick={next}>{index + 1 === questions.length ? "Kết thúc" : "Câu tiếp theo →"}</button></div>}</section>;
}

function LinkPage({ user }) {
  const [code, setCode] = useState(""); const [myCode, setMyCode] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const load = async () => { if (!user || !supabase) return; const { data: profile, error: profileError } = await supabase.from("profiles").select("link_code").eq("user_id", user.id).maybeSingle(); if (profileError) setError("Không thể tải mã liên kết. Hãy kiểm tra Supabase."); else if (profile) setMyCode(profile.link_code); };
  useEffect(() => { load(); }, [user]);
  const link = async e => { e.preventDefault(); setLoading(true); setError(""); setMessage(""); if (!supabase) { setError("Chưa cấu hình Supabase."); setLoading(false); return; } const { data, error: rpcError } = await supabase.rpc("link_account", { target_code: code.trim().toUpperCase() }); if (rpcError) setError(rpcError.message || "Không thể liên kết tài khoản."); else { setMessage(data?.message || "Đã liên kết tài khoản. Kho từ và chủ đề sẽ đồng bộ."); setCode(""); await load(); } setLoading(false); };
  if (!user) return <section className="page-card link-card"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">LIÊN KẾT</div><h2>Liên kết kho từ</h2><p>Bạn cần đăng nhập để tạo mã liên kết và kết nối kho từ với tài khoản khác.</p></section>;
  return <section className="page-card link-card"><div className="eyebrow">LIÊN KẾT</div><h2>Kết nối kho từ vựng</h2><p>Dùng mã của một tài khoản khác để chia sẻ kho. Từ mới và chủ đề được gán cho từng từ sẽ được đồng bộ giữa các tài khoản đã liên kết.</p><div className="my-code"><span>Mã liên kết của bạn</span><b>{myCode || "Đang tạo..."}</b></div><form className="add-form link-form" onSubmit={link}><input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Nhập mã liên kết của tài khoản kia" maxLength={8} required /><button className="primary" disabled={loading}>{loading ? "Đang liên kết..." : "🔗 Liên kết"}</button></form>{error && <div className="error-box">{error}</div>}{message && <div className="success-box">{message}</div>}<div className="sync-note"><b>Đồng bộ tự động</b><p>• Thêm một từ → từ đó được thêm vào kho của các tài khoản liên kết.<br/>• Đổi chủ đề của một từ → chủ đề được cập nhật cho các tài khoản liên kết.</p></div></section>;
}

function AccountPage({ user, profileUsername, authReady, onSignedIn, onSignOut }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async e => {
    e.preventDefault(); setLoading(true); setError(""); setMessage("");
    if (!supabase) { setError("Chưa cấu hình Supabase. Hãy kiểm tra biến môi trường."); setLoading(false); return; }
    try {
      if (mode === "login") {
        const value = cleanText(loginValue);
        let loginEmail = value;
        if (!value.includes("@")) {
          const { data: emailData, error: lookupError } = await supabase.rpc("get_login_email", { login_value: value.toLowerCase() });
          if (lookupError) throw lookupError;
          if (!emailData) throw new Error("Không tìm thấy tên đăng nhập này.");
          loginEmail = emailData;
        }
        const { data, error: signError } = await supabase.auth.signInWithPassword({ email: loginEmail.trim().toLowerCase(), password });
        if (signError) throw signError;
        onSignedIn(data.user); setMessage("Đăng nhập thành công.");
      } else {
        const cleanUsername = cleanText(username).toLowerCase();
        const cleanEmail = cleanText(email).toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(cleanUsername)) throw new Error("Tên đăng nhập dài 3–30 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới hoặc gạch ngang.");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error("Gmail/email không hợp lệ.");
        const { data: exists, error: existsError } = await supabase.rpc("username_available", { wanted_username: cleanUsername });
        if (existsError) throw existsError;
        if (!exists) throw new Error("Tên đăng nhập này đã được sử dụng.");
        const cooldownKey = `rot_signup_attempt_${cleanEmail}`;
        const lastAttempt = Number(localStorage.getItem(cooldownKey) || 0);
        if (Date.now() - lastAttempt < 30000) throw new Error("Vui lòng chờ khoảng 30 giây trước khi gửi lại yêu cầu đăng ký.");
        localStorage.setItem(cooldownKey, String(Date.now()));
        const { data, error: signError } = await supabase.auth.signUp({ email: cleanEmail, password, options: { data: { username: cleanUsername } } });
        if (signError) throw signError;
        if (data.session) { onSignedIn(data.user); setMessage("Tạo tài khoản thành công."); }
        else { setMessage("Tạo tài khoản thành công. Hãy kiểm tra Gmail/email để xác nhận tài khoản nếu Supabase yêu cầu."); }
      }
    } catch (err) { setError(authErrorMessage(err)); }
    finally { setLoading(false); }
  };
  if (!authReady) return <section className="page-card account-card"><h2>Tài khoản</h2><p>Đang kiểm tra phiên đăng nhập...</p></section>;
  if (user) return <section className="page-card account-card"><img src={carrotLogo} alt="Cà rốt" /><div className="eyebrow">TÀI KHOẢN</div><h2>Xin chào!</h2><p>Tên đăng nhập: <b>{profileUsername || user.user_metadata?.username || "Chưa có"}</b><br />Email: <b>{user.email}</b></p><button className="primary" onClick={onSignOut}>Đăng xuất</button></section>;
  return <section className="page-card account-card"><img src={carrotLogo} alt="Cà rốt" /><div className="eyebrow">TÀI KHOẢN</div><h2>{mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}</h2><p>{mode === "login" ? "Chỉ cần nhập Gmail/email hoặc tên đăng nhập, không cần nhập cả hai." : "Tạo tài khoản bằng tên đăng nhập, Gmail/email và mật khẩu. Mỗi email và tên đăng nhập chỉ dùng cho một tài khoản."}</p><form className="account-form" onSubmit={submit}>{mode === "signup" && <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Tên đăng nhập" minLength={3} maxLength={30} autoComplete="username" required />}{mode === "signup" ? <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Gmail / Email" autoComplete="email" required /> : <input type="text" value={loginValue} onChange={e => setLoginValue(e.target.value)} placeholder="Gmail / Email hoặc tên đăng nhập" autoComplete="username" required />}{<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mật khẩu (tối thiểu 6 ký tự)" minLength={6} autoComplete={mode === "login" ? "current-password" : "new-password"} required />}<button className="primary" disabled={loading}>{loading ? "Đang xử lý..." : mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}</button></form>{error && <div className="error-box">{error}</div>}{message && <div className="success-box">{message}</div>}<button className="link-btn" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); setMessage(""); }}>{mode === "login" ? "Chưa có tài khoản? Tạo tài khoản" : "Đã có tài khoản? Đăng nhập"}</button></section>;
}

function rowToVocab(row) {
  return {
    id: normalizeWord(row?.word_id || row?.word),
    word: cleanText(row?.word || row?.word_id),
    meaning: cleanText(row?.meaning),
    partOfSpeech: cleanText(row?.part_of_speech) || "Chưa xác định",
    ipa: cleanText(row?.ipa),
    audio: cleanText(row?.audio),
    collocations: normalizeDetailRows(row?.collocations),
    examples: normalizeDetailRows(row?.examples),
    definitionEn: cleanText(row?.definition_en),
    synonyms: Array.isArray(row?.synonyms) ? [...new Set(row.synonyms.map(cleanText).filter(Boolean))].slice(0, 8) : [],
    learnedAt: row?.learned_at,
    reps: Number.isFinite(Number(row?.reps)) ? Math.max(0, Number(row.reps)) : 0,
    topic: cleanText(row?.topic) || "Chưa phân loại",
  };
}

function App() {
  const [page, setPage] = useState("home"); const [user, setUser] = useState(null); const [profileUsername, setProfileUsername] = useState(""); const [authReady, setAuthReady] = useState(false); const [vocab, setVocab] = useState([]); const [vocabError, setVocabError] = useState("");
  const authVersion = useRef(0);
  const applySession = async (session, expectedVersion = authVersion.current) => {
    const nextUser = session?.user || null;
    if (expectedVersion !== authVersion.current) return;
    setUser(nextUser);
    if (!nextUser || !supabase) { setProfileUsername(""); return; }
    const metadataName = cleanText(nextUser.user_metadata?.username);
    setProfileUsername(metadataName);
    const { data } = await supabase.from("profiles").select("username").eq("user_id", nextUser.id).maybeSingle();
    if (expectedVersion !== authVersion.current) return;
    if (data?.username) setProfileUsername(data.username);
  };
  useEffect(() => {
    if (!supabase) { setAuthReady(true); return undefined; }
    let mounted = true;
    const initialVersion = authVersion.current;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted || initialVersion !== authVersion.current) return;
      await applySession(data.session, initialVersion);
      if (mounted && initialVersion === authVersion.current) setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      authVersion.current += 1;
      const version = authVersion.current;
      // Keep auth callbacks synchronous; fetch the profile after the callback.
      setUser(session?.user || null);
      setProfileUsername(cleanText(session?.user?.user_metadata?.username));
      setAuthReady(true);
      setTimeout(() => { if (mounted && session?.user && version === authVersion.current) applySession(session, version); }, 0);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!user || !supabase) { setVocab([]); setVocabError(""); return; }
    let alive = true;
    (async () => {
      // Supabase REST commonly returns at most 1,000 rows per request.
      // Load the vocabulary in pages so the app does not impose a 1,000-word cap.
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      try {
        while (alive) {
          const { data, error } = await supabase
            .from("user_vocab")
            .select("*")
            .order("learned_at", { ascending: false })
            .range(from, from + pageSize - 1);
          if (error) throw error;
          const rows = data || [];
          allRows.push(...rows);
          if (rows.length < pageSize) break;
          from += pageSize;
        }
        if (alive) { setVocab(allRows.map(rowToVocab)); setVocabError(""); }
      } catch (error) {
        if (alive) setVocabError("Không thể tải kho từ lúc này. Hãy kiểm tra kết nối Supabase rồi tải lại trang.");
      }
    })();
    return () => { alive = false; };
  }, [user]);
  const signOut = async () => {
    if (supabase) { const { error } = await supabase.auth.signOut(); if (error) return; }
    setUser(null); setProfileUsername(""); setVocab([]); setPage("home");
  };
  const goAccount = () => setPage("account");
  return <div className="carrot-app"><Header page={page} setPage={setPage} user={user} onAccount={goAccount} /><main className="content">{page === "home" && <Home setPage={setPage} user={user} profileUsername={profileUsername} />}{page === "vocab" && <VocabPage vocab={vocab} setVocab={setVocab} user={user} setPage={setPage} vocabError={vocabError} />}{page === "review" && <ReviewPage vocab={vocab} user={user} setPage={setPage} />}{page === "account" && <AccountPage user={user} profileUsername={profileUsername} authReady={authReady} onSignedIn={user => applySession({ user })} onSignOut={signOut} />} {page === "link" && <LinkPage user={user} />}</main><footer>🥕 Học tiếng Anh cùng Rốt</footer></div>;
}

createRoot(document.getElementById("root")).render(<App />);
