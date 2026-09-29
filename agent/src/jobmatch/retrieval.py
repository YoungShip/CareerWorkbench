"""BM25、FAISS 内积检索与 RRF 融合；模型和索引缓存只保存在私有目录。"""

from __future__ import annotations

import hashlib
import os
import re
import threading
from pathlib import Path
from typing import Protocol

import numpy as np

from .corpus import Chunk, Corpus

MODES = ("full", "bm25", "dense", "hybrid")


class Embedder(Protocol):
    model_name: str
    def documents(self, texts: list[str]) -> np.ndarray: ...
    def query(self, text: str) -> np.ndarray: ...


class LocalEmbedder:
    model_name = "BAAI/bge-small-zh-v1.5"

    def __init__(self, models_dir: Path):
        from fastembed import TextEmbedding

        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        self.model = TextEmbedding(self.model_name, cache_dir=str(models_dir))
        self.lock = threading.Lock()

    def documents(self, texts):
        with self.lock:
            return np.asarray(list(self.model.embed(texts)), dtype=np.float32)

    def query(self, text):
        with self.lock:
            return np.asarray(list(self.model.query_embed(text)), dtype=np.float32)


def tokens(text: str) -> list[str]:
    import jieba

    jieba.setLogLevel(30)
    return [t for t in jieba.lcut_for_search(text.lower()) if re.search(r"\w", t)]


def unit_vectors(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=np.float32)
    if values.ndim != 2 or not np.isfinite(values).all():
        raise ValueError("向量必须是有限值的二维矩阵")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    if (norms == 0).any():
        raise ValueError("模型返回零向量")
    return np.ascontiguousarray(values / norms)


class Retriever:
    def __init__(self, corpus: Corpus, mode="hybrid", *, embedder: Embedder | None = None, cache_dir: Path | None = None):
        if mode not in MODES or not corpus.chunks:
            raise ValueError("检索模式无效或证据库为空")
        self.corpus, self.mode, self.embedder = corpus, mode, embedder
        self.bm25 = self.index = None
        if mode in {"bm25", "hybrid"}:
            from rank_bm25 import BM25Okapi

            self.tokenized = [tokens(c.text) or ["_empty"] for c in corpus.chunks]
            self.bm25 = BM25Okapi(self.tokenized)
        if mode in {"dense", "hybrid"}:
            import faiss

            if embedder is None:
                raise ValueError("向量模式需要 embedder")
            key = hashlib.sha256((corpus.snapshot + "\n" + embedder.model_name).encode()).hexdigest()
            cache = cache_dir / f"embeddings-{key}.npy" if cache_dir else None
            if cache and cache.is_file():
                vectors = unit_vectors(np.load(cache, allow_pickle=False))
            else:
                vectors = unit_vectors(embedder.documents([c.text for c in corpus.chunks]))
                if cache:
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    temp = cache.with_suffix(".tmp")
                    with temp.open("wb") as fh:
                        np.save(fh, vectors, allow_pickle=False)
                    temp.replace(cache)
            if len(vectors) != len(corpus.chunks):
                raise ValueError("向量缓存与证据库条数不一致")
            self.index = faiss.IndexFlatIP(vectors.shape[1])
            self.index.add(vectors)

    def search(self, query: str, top_k=5) -> list[Chunk]:
        if self.mode == "full":
            return list(self.corpus.chunks)
        top_k = min(max(int(top_k), 1), len(self.corpus.chunks))
        rankings = []
        if self.bm25 is not None:
            query_tokens = tokens(query)
            scores = self.bm25.get_scores(query_tokens)
            candidates = [i for i, ts in enumerate(self.tokenized) if set(ts) & set(query_tokens)]
            rankings.append(sorted(candidates, key=lambda i: (-scores[i], i)))
        if self.index is not None:
            vector = unit_vectors(self.embedder.query(query))
            if vector.shape != (1, self.index.d):
                raise ValueError("查询向量维度不一致")
            _, indices = self.index.search(vector, len(self.corpus.chunks))
            rankings.append([int(i) for i in indices[0] if i >= 0])
        if len(rankings) == 1:
            order = rankings[0]
        else:
            scores = {}
            for ranking in rankings:
                for rank, i in enumerate(ranking, 1):
                    scores[i] = scores.get(i, 0) + 1 / (60 + rank)
            order = sorted(scores, key=lambda i: (-scores[i], i))
        return [self.corpus.chunks[i] for i in order[:top_k]]

    def boundaries(self) -> list[Chunk]:
        return [c for c in self.corpus.chunks if c.kind == "边界"]
