import numpy as np
import pytest

from jobmatch.retrieval import Retriever, unit_vectors


class Embeddings:
    model_name = "fake-3d"
    calls = 0

    def documents(self, texts):
        self.calls += 1
        return np.eye(len(texts), 3, dtype=np.float32)

    def query(self, text):
        return np.array([[1., 0., 0.]], dtype=np.float32)


@pytest.mark.parametrize("mode", ["bm25", "dense", "hybrid", "full"])
def test_retrieval_finds_direct_evidence_and_preserves_boundaries(corpus, mode):
    engine = Retriever(corpus, mode, embedder=Embeddings())
    assert engine.search("Python FastAPI", 1)[0].id == "python"
    assert [c.id for c in engine.boundaries()] == ["limit"]


def test_embedding_cache_and_version_invalidation(corpus, tmp_path):
    from jobmatch.corpus import Chunk, Corpus

    embed = Embeddings()
    Retriever(corpus, "dense", embedder=embed, cache_dir=tmp_path)
    Retriever(corpus, "dense", embedder=embed, cache_dir=tmp_path)
    assert embed.calls == 1
    changed = Corpus([Chunk(c.id, c.kind, c.text + "更新", c.source) for c in corpus.chunks])
    Retriever(changed, "dense", embedder=embed, cache_dir=tmp_path)
    assert embed.calls == 2


def test_bm25_has_no_fake_hits(corpus):
    assert Retriever(corpus, "bm25").search("zzunseen999") == []


@pytest.mark.parametrize("values", [[[0, 0]], [[float("nan"), 1]], [1, 2]])
def test_reject_invalid_embeddings(values):
    with pytest.raises(ValueError):
        unit_vectors(np.asarray(values))


def test_concurrent_embedding_cache_writers_do_not_share_temporary_file(corpus, tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from pathlib import Path
    from threading import Barrier, Event, Lock

    generated, ready_to_publish = Barrier(2), Barrier(2)
    first_published, publish_order = Event(), []
    order_lock = Lock()
    original_replace = Path.replace

    class ConcurrentEmbeddings(Embeddings):
        def documents(self, texts):
            result = super().documents(texts)
            generated.wait(timeout=10)
            return result

    def synchronized_replace(path, target):
        if path.suffix == ".tmp" and path.name.startswith("embeddings-"):
            ready_to_publish.wait(timeout=10)
            with order_lock:
                publish_order.append(path)
                first = len(publish_order) == 1
            if first:
                try:
                    return original_replace(path, target)
                finally:
                    first_published.set()
            assert first_published.wait(timeout=10)
        return original_replace(path, target)

    monkeypatch.setattr(Path, "replace", synchronized_replace)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(Retriever, corpus, "dense", embedder=ConcurrentEmbeddings(), cache_dir=tmp_path)
                   for _ in range(2)]
        engines = [future.result(timeout=20) for future in futures]
    assert all(engine.search("Python", 1)[0].id == "python" for engine in engines)
    assert len(list(tmp_path.glob("embeddings-*.npy"))) == 1
    assert not list(tmp_path.glob("*.tmp"))
    cached = Retriever(corpus, "dense", embedder=Embeddings(), cache_dir=tmp_path)
    assert cached.search("Python", 1)[0].id == "python"
