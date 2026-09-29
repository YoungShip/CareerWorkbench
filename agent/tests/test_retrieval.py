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
