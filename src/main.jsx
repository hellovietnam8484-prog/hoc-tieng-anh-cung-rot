import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@supabase/supabase-js";
import carrotLogo from "./assets/carrot-logo.png";
import "./styles.css";

const STORAGE_KEY = "rot_vocab_v1";
const REVIEW_KEY = "rot_review_v1";
const DEFAULT_TOPICS = ["Chưa phân loại"];
const TOPIC_STORAGE = "rot_custom_topics_v1";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

const cleanText = (value) => String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const cap = (value) => { const text = cleanText(value); return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""; };
const normalizeWord = (value) => cleanText(value).toLowerCase();
const formatIpa = (value) => { const text = cleanText(value).replace(/^\/+|\/+$/g, ""); return text ? `/${text}/` : ""; };

async function translate(text) {
  const q = cleanText(text); if (!q) return "";
  const cacheKey = `rot_trans_${q}`;
  try {
    const cached = localStorage.getItem(cacheKey); if (cached) return cached;
    const response = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en|vi`);
    if (!response.ok) throw new Error("translation_failed");
    const data = await response.json(); const result = cleanText(data?.responseData?.translatedText);
    if (result) localStorage.setItem(cacheKey, result);
    return result || "Chưa có bản dịch tự động";
  } catch { return "Chưa có bản dịch tự động"; }
}

async function fetchDictionary(word) {
  const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!response.ok) throw new Error("not_found");
  const data = await response.json(); const entry = data?.[0] || {}; const meanings = entry.meanings || [];
  const first = meanings[0] || {};
  const definition = cleanText(first.definitions?.[0]?.definition);
  const allExamples = meanings.flatMap((m) => (m.definitions || []).map((d) => cleanText(d.example)).filter(Boolean));
  const phonetic = entry.phonetic || entry.phonetics?.find((p) => p.text)?.text || "";
  const audio = entry.phonetics?.find((p) => p.audio)?.audio || "";
  const partOfSpeech = first.partOfSpeech || meanings.find((m) => m.partOfSpeech)?.partOfSpeech || "";
  return { word: entry.word || word, phonetic: formatIpa(phonetic), audio, partOfSpeech: cap(partOfSpeech), definition, examples: [...new Set(allExamples)].slice(0, 3), synonyms: [...new Set(meanings.flatMap((m) => m.synonyms || []))].slice(0, 8) };
}

async function fetchCollocations(word) {
  try {
    const requests = [
      `https://api.datamuse.com/words?rel_jjb=${encodeURIComponent(word)}&max=5`,
      `https://api.datamuse.com/words?rel_jja=${encodeURIComponent(word)}&max=5`,
      `https://api.datamuse.com/words?rel_trg=${encodeURIComponent(word)}&max=5`,
    ];
    const results = await Promise.all(requests.map((url) => fetch(url).then((r) => (r.ok ? r.json() : []))));
    const words = results.flat().map((item) => cleanText(item.word)).filter(Boolean);
    return [...new Set(words)].filter((item) => item.toLowerCase() !== word.toLowerCase()).slice(0, 8).map((item) => `${item} ${word}`);
  } catch { return []; }
}

async function enrichWord(word) {
  const key = `rot_dict_${normalizeWord(word)}`;
  try { const cached = localStorage.getItem(key); if (cached) return JSON.parse(cached); } catch {}
  const base = await fetchDictionary(word);
  const meaning = await translate(base.definition || base.word);
  const exampleRows = await Promise.all(base.examples.map(async (example) => ({ en: example, vi: await translate(example) })));
  const rawCollocations = await fetchCollocations(base.word);
  const collocations = await Promise.all(rawCollocations.map(async (phrase) => ({ en: phrase, vi: await translate(phrase) })));
  const result = { id: normalizeWord(base.word), word: base.word, meaning: cap(meaning), partOfSpeech: base.partOfSpeech || "Chưa xác định", ipa: base.phonetic || "", audio: base.audio || "", collocations, examples: exampleRows, definitionEn: cap(base.definition), synonyms: base.synonyms, learnedAt: new Date().toISOString(), reps: 0 };
  localStorage.setItem(key, JSON.stringify(result));
  return result;
}

function shuffle(items) { return [...items].sort(() => Math.random() - 0.5); }
function buildQuestions(vocab, count) {
  if (!vocab.length) return [];
  const source = shuffle(vocab); const questions = []; const types = ["word", "phrase", "sentence", "fill"];
  for (let i = 0; i < count; i += 1) {
    const item = source[i % source.length]; const type = types[i % types.length];
    if (type === "word") {
      const answer = item.meaning || "Chưa có nghĩa"; const distractors = shuffle(vocab.filter(v => v.id !== item.id).map(v => v.meaning).filter(Boolean)).slice(0, 3);
      if (distractors.length < 3) continue;
      questions.push({ type, prompt: item.word, label: "Chọn nghĩa tiếng Việt đúng cho từ:", answer, choices: shuffle([answer, ...distractors]), wordId: item.id });
    } else if (type === "phrase" && item.collocations?.length) {
      const phrase = item.collocations[0]; const answer = phrase.vi || "Chưa có nghĩa";
      const distractors = shuffle(vocab.flatMap(v => v.collocations || []).filter(p => p.en !== phrase.en).map(p => p.vi).filter(Boolean)).slice(0, 3);
      if (distractors.length < 3) continue;
      questions.push({ type, prompt: phrase.en, label: "Chọn nghĩa tiếng Việt đúng cho cụm từ:", answer, choices: shuffle([answer, ...distractors]), wordId: item.id });
    } else if (type === "sentence" && item.examples?.length) {
      const example = item.examples[0]; const answer = example.vi || "Chưa có nghĩa";
      const distractors = shuffle(vocab.flatMap(v => v.examples || []).filter(e => e.en !== example.en).map(e => e.vi).filter(Boolean)).slice(0, 3);
      if (distractors.length < 3) continue;
      questions.push({ type, prompt: example.en, label: "Chọn nghĩa tiếng Việt đúng cho câu:", answer, choices: shuffle([answer, ...distractors]), wordId: item.id });
    } else {
      const example = item.examples?.[0]; const sentence = example?.en || `I really like ${item.word}.`;
      const blank = sentence.replace(new RegExp(`\\b${item.word}\\b`, "i"), "_____ ").replace(/\s+$/, "");
      const answer = item.word; const distractors = shuffle(vocab.filter(v => v.id !== item.id).map(v => v.word)).slice(0, 3);
      if (distractors.length < 3) continue;
      questions.push({ type: "fill", prompt: blank, label: "Chọn từ điền vào chỗ trống:", answer, choices: shuffle([answer, ...distractors]), wordId: item.id });
    }
  }
  return questions;
}

function Header({ page, setPage, user, onAccount }) {
  return <header className="topbar">
    <div className="brand-mini" onClick={() => setPage("home")}><img src={carrotLogo} alt="Cà rốt" /><span>Học tiếng anh cùng rốt</span></div>
    <nav>
      <button className={page === "home" ? "active" : ""} onClick={() => setPage("home")}>Trang chủ</button>
      <button className={page === "vocab" ? "active" : ""} onClick={() => setPage("vocab")}>Từ vựng</button>
      <button className={page === "review" ? "active" : ""} onClick={() => setPage("review")}>Ôn tập</button>
      <button className={page === "account" ? "active" : ""} onClick={onAccount}>Tài khoản</button>
      <button className={page === "link" ? "active" : ""} onClick={() => setPage("link")}>Liên kết</button>
    </nav>
  </header>;
}

function Home({ setPage, user }) {
  return <section className="home-card">
    <img className="hero-carrot" src={carrotLogo} alt="Cà rốt" />
    <div className="eyebrow">HỌC TIẾNG ANH MỖI NGÀY</div>
    <h1>Học tiếng anh<br />cùng rốt</h1>
    <p>{user ? `Xin chào ${user.email}. Từ bạn thêm sẽ được lưu vào tài khoản.` : "Đăng nhập để lưu từ vựng và ôn tập trên mọi lần mở ứng dụng."}</p>
    <div className="home-actions">
      <button className="primary" onClick={() => setPage("vocab")}>＋ Thêm từ vựng</button>
      <button className="secondary" onClick={() => setPage("review")}>▶ Ôn tập ngay</button>
    </div>
  </section>;
}

function VocabPage({ vocab, setVocab, user, setPage }) {
  const [word, setWord] = useState(""); const [detail, setDetail] = useState(null); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [query, setQuery] = useState(""); const [newTopic, setNewTopic] = useState(""); const [customTopics, setCustomTopics] = useState([]);
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
  const createTopic = (event) => {
    event.preventDefault();
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
    event.preventDefault(); setError("");
    if (!user) { setError("Bạn cần đăng nhập để lưu từ vựng. Bạn vẫn có thể xem tra cứu, nhưng từ sẽ không được lưu khi chưa đăng nhập."); return; }
    const clean = normalizeWord(word); if (!clean) return; setLoading(true);
    try {
      const data = await enrichWord(clean);
      const payload = { user_id: user.id, word_id: data.id, word: data.word, meaning: data.meaning, part_of_speech: data.partOfSpeech, ipa: data.ipa, audio: data.audio, collocations: data.collocations || [], examples: data.examples || [], definition_en: data.definitionEn || "", synonyms: data.synonyms || [], learned_at: data.learnedAt, reps: data.reps || 0, topic: "Chưa phân loại" };
      if (!supabase) throw new Error("supabase_missing");
      const { data: saved, error: saveError } = await supabase.from("user_vocab").upsert(payload, { onConflict: "user_id,word_id" }).select().single();
      if (saveError) throw saveError;
      const normalized = rowToVocab(saved);
      setVocab(current => current.some(item => item.id === normalized.id) ? current.map(item => item.id === normalized.id ? normalized : item) : [normalized, ...current]);
      setDetail(normalized); setWord("");
    } catch (e) { setError(e?.message === "supabase_missing" ? "Chưa cấu hình Supabase. Hãy điền VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY trong file .env.local." : "Không thể lưu từ. Hãy kiểm tra kết nối và cấu hình tài khoản rồi thử lại."); }
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
  const removeWord = async (item) => {
    if (!user || !supabase) return;
    const { error: deleteError } = await supabase.from("user_vocab").delete().eq("user_id", user.id).eq("word_id", item.id);
    if (!deleteError) { setVocab(current => current.filter(v => v.id !== item.id)); if (detail?.id === item.id) setDetail(null); }
  };
  const filtered = useMemo(() => { const q = cleanText(query).toLowerCase(); return q ? vocab.filter(item => item.word.toLowerCase().includes(q) || item.meaning.toLowerCase().includes(q)) : vocab; }, [vocab, query]);
  return <section className="page-card">
    <div className="page-heading"><div><div className="eyebrow">KHO CÁ NHÂN</div><h2>Từ vựng</h2><p>Nhập từ tiếng Anh để lấy nghĩa tiếng Việt, từ loại, phiên âm, cụm từ và ví dụ. <b>Không giới hạn số lần thêm từ và số từ trong kho.</b> Từ chỉ được lưu khi bạn đăng nhập.</p></div><div className="count-badge">{vocab.length} từ đã lưu · Không giới hạn</div></div>
    {!user && <div className="login-notice">🔐 Muốn lưu từ và dùng ôn tập, hãy <button onClick={() => setPage("account")}>đăng nhập / tạo tài khoản</button>.</div>}
    <form className="add-form" onSubmit={addWord}><input value={word} onChange={e => setWord(e.target.value)} placeholder="Ví dụ: environment" aria-label="Từ tiếng Anh" /><button className="primary" disabled={loading || !user}>{loading ? "Đang lưu..." : "＋ Thêm từ"}</button></form>
    {error && <div className="error-box">{error}</div>}
    {detail && <WordDetail item={detail} onClose={() => setDetail(null)} onDelete={() => removeWord(detail)} />}
    <div className="topic-manager">
      <div><h3>Chủ đề của bạn</h3><p className="muted">Tự đặt tên chủ đề để phân loại từ theo cách bạn muốn.</p></div>
      <form onSubmit={createTopic} className="topic-create"><input value={newTopic} onChange={e => setNewTopic(e.target.value)} placeholder="Ví dụ: Từ vựng IELTS Writing" /><button className="secondary" disabled={!user}>＋ Tạo chủ đề</button></form>
      <div className="topic-chips">{topics.map(topic => <span className="topic-chip" key={topic}>{topic}</span>)}</div>
    </div>
    <div className="list-toolbar"><div><h3>Từ đã lưu</h3><span className="muted">Chọn chủ đề ngay trên từng từ.</span></div><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm từ hoặc nghĩa..." /></div>
    <div className="vocab-list">{filtered.length === 0 && <div className="empty">{user ? "Chưa có từ nào. Hãy thêm từ đầu tiên ở phía trên." : "Đăng nhập để xem kho từ cá nhân."}</div>}{filtered.map(item => <div className="vocab-row" key={item.id} onClick={() => setDetail(item)}><div className="word-main"><b>{item.word}</b><span>{item.partOfSpeech}</span></div><div className="word-meaning">{item.meaning || "Chưa có nghĩa"}</div><div className="word-ipa">{item.ipa || "—"}</div><select className="topic-select" value={item.topic || "Chưa phân loại"} onClick={e => e.stopPropagation()} onChange={e => updateTopic(item, e.target.value)}>{topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}</select><span className="arrow">›</span></div>)}</div>
  </section>;
}

function WordDetail({ item, onClose, onDelete }) {
  const [translated, setTranslated] = useState({});
  useEffect(() => { let alive = true; (async () => { const all = [...(item.collocations || []), ...(item.examples || [])]; const values = {}; for (const row of all) values[row.en] = row.vi || await translate(row.en); if (alive) setTranslated(values); })(); return () => { alive = false; }; }, [item]);
  return <div className="detail-panel"><div className="detail-head"><div><h3>{item.word}</h3><div className="meta-line">{item.partOfSpeech || "Chưa xác định"}{item.ipa ? <span className="ipa-line">{item.ipa}</span> : null}</div></div><div className="detail-actions"><button className="icon-btn" onClick={onClose}>×</button>{onDelete && <button className="delete-btn" onClick={onDelete}>Xóa từ</button>}</div></div><div className="meaning-big">{item.meaning || "Chưa có nghĩa"}</div><div className="detail-topic"><b>Chủ đề:</b> {item.topic || "Chưa phân loại"}</div>{item.audio && <button className="audio-btn" onClick={() => new Audio(item.audio).play()}>🔊 Nghe phát âm</button>}<div className="detail-grid"><div><h4>Cụm từ</h4>{item.collocations?.length ? item.collocations.map(row => <div className="hover-line" key={row.en} title={translated[row.en] || "Đang dịch..."}><b>{row.en}</b><small>{translated[row.en] || "Đang dịch..."}</small></div>) : <div className="muted">Chưa lấy được cụm từ tự động.</div>}</div><div><h4>Ví dụ</h4>{item.examples?.length ? item.examples.map(row => <div className="hover-line example" key={row.en} title={translated[row.en] || "Đang dịch..."}><b>{row.en}</b><small>{translated[row.en] || "Đang dịch..."}</small></div>) : <div className="muted">Chưa có ví dụ.</div>}</div></div>{item.definitionEn && <div className="english-definition"><b>Giải thích tiếng Anh:</b> {item.definitionEn}</div>}</div>;
}

function ReviewPage({ vocab, user, setPage }) {
  const [questions, setQuestions] = useState([]); const [index, setIndex] = useState(0); const [choice, setChoice] = useState(null); const [started, setStarted] = useState(false); const [score, setScore] = useState(0); const [count, setCount] = useState(10); const [reviewMode, setReviewMode] = useState("random"); const [reviewTopic, setReviewTopic] = useState("");
  const current = questions[index]; const answered = choice !== null;
  const topics = [...new Set(vocab.map(v => v.topic).filter(t => t && t !== "Chưa phân loại"))].sort((a,b) => a.localeCompare(b, "vi"));
  const start = () => {
    const pool = reviewMode === "topic" ? vocab.filter(v => v.topic === reviewTopic) : vocab;
    const built = buildQuestions(pool, Number(count));
    setQuestions(built); setIndex(0); setChoice(null); setScore(0); setStarted(built.length > 0);
  };
  const answer = selected => { if (answered) return; setChoice(selected); if (selected === current.answer) setScore(s => s + 1); localStorage.setItem(REVIEW_KEY, JSON.stringify({ lastReview: new Date().toISOString(), wordId: current.wordId })); };
  const next = () => { if (index + 1 >= questions.length) { setStarted(false); return; } setIndex(i => i + 1); setChoice(null); };
  if (!user) return <section className="page-card review-start"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">ÔN TẬP</div><h2>Ôn tập từ đã học</h2><p>Bạn cần đăng nhập để rốt lấy đúng những từ bạn đã lưu và tạo bộ câu hỏi cá nhân.</p><button className="primary large" onClick={() => setPage("account")}>🔐 Đăng nhập để ôn tập</button></section>;
  if (!started) return <section className="page-card review-start"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">ÔN TẬP</div><h2>Ôn tập từ đã học</h2><p>Ôn tập <b>không giới hạn số lần</b>. Bạn có thể tạo bộ mới bất cứ lúc nào: ngẫu nhiên từ toàn bộ kho hoặc chỉ ôn theo một chủ đề.</p><div className="review-stats"><b>{vocab.length}</b><span>từ đã lưu</span></div>{vocab.length === 0 && <div className="error-box">Hãy thêm ít nhất 1 từ ở mục Từ vựng trước khi bắt đầu ôn tập.</div>}<div className="review-mode-picker"><span>Phạm vi ôn tập</span><div className="mode-buttons"><button className={reviewMode === "random" ? "selected" : ""} onClick={() => setReviewMode("random")}>🎲 Ngẫu nhiên từ đã thêm</button><button className={reviewMode === "topic" ? "selected" : ""} onClick={() => setReviewMode("topic")}>🏷️ Ôn theo chủ đề</button></div>{reviewMode === "topic" && <select value={reviewTopic} onChange={e => setReviewTopic(e.target.value)}><option value="">-- Chọn chủ đề --</option>{topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}</select>}{reviewMode === "topic" && !topics.length && <small className="muted">Bạn chưa tạo chủ đề nào. Hãy tạo chủ đề trong mục Từ vựng.</small>}</div><div className="count-picker"><span>Số câu mỗi lượt</span>{[10,20,30].map(n => <button key={n} className={count === n ? "selected" : ""} onClick={() => setCount(n)}>{n}</button>)}</div><button className="primary large" disabled={!vocab.length || (reviewMode === "topic" && !reviewTopic)} onClick={start}>▶ Bắt đầu ôn tập</button></section>;
  const correct = choice === current.answer;
  return <section className="page-card quiz-card"><div className="quiz-top"><span>Câu {index + 1}/{questions.length}</span><b>Điểm: {score}</b><button className="secondary small" onClick={() => setStarted(false)}>Thoát</button></div><div className="progress"><span style={{ width: `${((index + 1) / questions.length) * 100}%` }} /></div><div className="question-label">{current.label}</div><div className="question-prompt">{current.prompt}</div><div className="choices">{current.choices.map((option, i) => { const letter = String.fromCharCode(65 + i); const isCorrect = option === current.answer; const isChosen = option === choice; return <button key={`${option}-${i}`} className={`choice ${answered ? (isCorrect ? "correct" : isChosen ? "wrong" : "muted-choice") : ""}`} onClick={() => answer(option)}><b>{letter}.</b><span>{option}</span></button>; })}</div>{answered && <div className={`feedback ${correct ? "good" : "bad"}`}><b>{correct ? "✓ Chính xác!" : `✗ Đáp án đúng: ${current.answer}`}</b><p>{current.type === "fill" ? `Từ “${current.answer}” phù hợp nhất với ngữ cảnh của câu.` : `Đây là nghĩa phù hợp nhất với nội dung đang được hỏi.`}</p><button className="primary" onClick={next}>{index + 1 === questions.length ? "Kết thúc" : "Câu tiếp theo →"}</button></div>}</section>;
}

function LinkPage({ user }) {
  const [code, setCode] = useState(""); const [myCode, setMyCode] = useState(""); const [members, setMembers] = useState([]); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const load = async () => { if (!user || !supabase) return; const { data: profile } = await supabase.from("profiles").select("link_code").eq("user_id", user.id).maybeSingle(); if (profile) setMyCode(profile.link_code); const { data: rows } = await supabase.from("vocab_group_members").select("user_id, profiles!inner(link_code)").eq("user_id", user.id); if (rows) setMembers(rows); };
  useEffect(() => { load(); }, [user]);
  const link = async e => { e.preventDefault(); setLoading(true); setError(""); setMessage(""); if (!supabase) { setError("Chưa cấu hình Supabase."); setLoading(false); return; } const { data, error: rpcError } = await supabase.rpc("link_account", { target_code: code.trim().toUpperCase() }); if (rpcError) setError(rpcError.message || "Không thể liên kết tài khoản."); else { setMessage(data?.message || "Đã liên kết tài khoản. Kho từ và chủ đề sẽ đồng bộ."); setCode(""); await load(); } setLoading(false); };
  if (!user) return <section className="page-card link-card"><div className="review-carrot"><img src={carrotLogo} alt="Cà rốt" /></div><div className="eyebrow">LIÊN KẾT</div><h2>Liên kết kho từ</h2><p>Bạn cần đăng nhập để tạo mã liên kết và kết nối kho từ với tài khoản khác.</p></section>;
  return <section className="page-card link-card"><div className="eyebrow">LIÊN KẾT</div><h2>Kết nối kho từ vựng</h2><p>Dùng mã của một tài khoản khác để chia sẻ kho. Từ mới và thay đổi chủ đề sẽ được đồng bộ giữa các tài khoản đã liên kết.</p><div className="my-code"><span>Mã liên kết của bạn</span><b>{myCode || "Đang tạo..."}</b></div><form className="add-form link-form" onSubmit={link}><input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Nhập mã liên kết của tài khoản kia" maxLength={8} required /><button className="primary" disabled={loading}>{loading ? "Đang liên kết..." : "🔗 Liên kết"}</button></form>{error && <div className="error-box">{error}</div>}{message && <div className="success-box">{message}</div>}<div className="sync-note"><b>Đồng bộ tự động</b><p>• Thêm một từ → từ đó được thêm vào kho của các tài khoản liên kết.<br/>• Đổi chủ đề của một từ → chủ đề được cập nhật cho các tài khoản liên kết.</p></div></section>;
}

function AccountPage({ user, authReady, onSignedIn, onSignOut }) {
  const [mode, setMode] = useState("login"); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [loading, setLoading] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const submit = async e => { e.preventDefault(); setLoading(true); setError(""); setMessage(""); if (!supabase) { setError("Chưa cấu hình Supabase. Hãy tạo file .env.local từ .env.example và điền URL + anon key."); setLoading(false); return; } try { if (mode === "login") { const { data, error: signError } = await supabase.auth.signInWithPassword({ email: email.trim(), password }); if (signError) throw signError; onSignedIn(data.user); setMessage("Đăng nhập thành công."); } else { const { data, error: signError } = await supabase.auth.signUp({ email: email.trim(), password }); if (signError) throw signError; onSignedIn(data.user); setMessage(data.session ? "Tạo tài khoản thành công." : "Tài khoản đã tạo. Nếu Supabase bật xác minh email, hãy mở email để xác nhận trước khi đăng nhập."); } } catch (err) { setError(err?.message || "Không thể thực hiện. Hãy kiểm tra email và mật khẩu."); } finally { setLoading(false); } };
  if (!authReady) return <section className="page-card account-card"><h2>Tài khoản</h2><p>Đang kiểm tra phiên đăng nhập...</p></section>;
  if (user) return <section className="page-card account-card"><img src={carrotLogo} alt="Cà rốt" /><div className="eyebrow">TÀI KHOẢN</div><h2>Xin chào!</h2><p>Tài khoản đang đăng nhập: <b>{user.email}</b></p><div className="account-note">🔒 Từ vựng của bạn được lưu riêng theo tài khoản trên Supabase.</div><button className="primary" onClick={onSignOut}>Đăng xuất</button></section>;
  return <section className="page-card account-card"><img src={carrotLogo} alt="Cà rốt" /><div className="eyebrow">TÀI KHOẢN</div><h2>{mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}</h2><p>{mode === "login" ? "Đăng nhập để lưu từ vựng và ôn tập." : "Tạo tài khoản để kho từ được lưu lại."}</p><form className="account-form" onSubmit={submit}><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required /><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Mật khẩu (tối thiểu 6 ký tự)" minLength={6} required /><button className="primary" disabled={loading}>{loading ? "Đang xử lý..." : mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}</button></form>{error && <div className="error-box">{error}</div>}{message && <div className="success-box">{message}</div>}<button className="link-btn" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); setMessage(""); }}>{mode === "login" ? "Chưa có tài khoản? Tạo tài khoản" : "Đã có tài khoản? Đăng nhập"}</button></section>;
}

function rowToVocab(row) { return { id: row.word_id, word: row.word, meaning: row.meaning || "", partOfSpeech: row.part_of_speech || "Chưa xác định", ipa: row.ipa || "", audio: row.audio || "", collocations: row.collocations || [], examples: row.examples || [], definitionEn: row.definition_en || "", synonyms: row.synonyms || [], learnedAt: row.learned_at, reps: row.reps || 0, topic: row.topic || "Chưa phân loại" }; }

function App() {
  const [page, setPage] = useState("home"); const [user, setUser] = useState(null); const [authReady, setAuthReady] = useState(false); const [vocab, setVocab] = useState([]);
  useEffect(() => { if (!supabase) { setAuthReady(true); return undefined; } let mounted = true; supabase.auth.getSession().then(({ data }) => { if (mounted) { setUser(data.session?.user || null); setAuthReady(true); } }); const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => { setUser(session?.user || null); setAuthReady(true); }); return () => { mounted = false; listener.subscription.unsubscribe(); }; }, []);
  useEffect(() => {
    if (!user || !supabase) { setVocab([]); return; }
    let alive = true;
    (async () => {
      // Supabase REST commonly returns at most 1,000 rows per request.
      // Load the vocabulary in pages so the app does not impose a 1,000-word cap.
      const pageSize = 1000;
      let from = 0;
      const allRows = [];
      while (alive) {
        const { data, error } = await supabase
          .from("user_vocab")
          .select("*")
          .order("learned_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) break;
        const rows = data || [];
        allRows.push(...rows);
        if (rows.length < pageSize) break;
        from += pageSize;
      }
      if (alive) setVocab(allRows.map(rowToVocab));
    })();
    return () => { alive = false; };
  }, [user]);
  useEffect(() => { if (user || !vocab.length) return; localStorage.removeItem(STORAGE_KEY); }, [user, vocab.length]);
  const signOut = async () => { if (supabase) await supabase.auth.signOut(); setUser(null); setVocab([]); setPage("home"); };
  const goAccount = () => setPage("account");
  return <div className="carrot-app"><Header page={page} setPage={setPage} user={user} onAccount={goAccount} /><main className="content">{page === "home" && <Home setPage={setPage} user={user} />}{page === "vocab" && <VocabPage vocab={vocab} setVocab={setVocab} user={user} setPage={setPage} />}{page === "review" && <ReviewPage vocab={vocab} user={user} setPage={setPage} />}{page === "account" && <AccountPage user={user} authReady={authReady} onSignedIn={setUser} onSignOut={signOut} />} {page === "link" && <LinkPage user={user} />}</main><footer>🥕 Học tiếng anh cùng rốt · Từ đã lưu được bảo vệ theo tài khoản</footer></div>;
}

createRoot(document.getElementById("root")).render(<App />);
