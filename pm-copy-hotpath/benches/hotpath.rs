//! Micro-benchmark: trader score map lookup (allocation-free on hit).

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use pm_copy_hotpath::trader_db::TraderDb;

fn bench_trader_lookup(c: &mut Criterion) {
    let dir = std::env::temp_dir().join("pm-hotpath-bench.json");
    let json = r#"{"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":0.9,"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":0.5}"#;
    std::fs::write(&dir, json).unwrap();
    let db = TraderDb::load(&dir).unwrap();
    let key = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    c.bench_function("trader_db_score_for", |b| {
        b.iter(|| black_box(db.score_for(black_box(key))))
    });
    std::fs::remove_file(&dir).ok();
}

criterion_group!(benches, bench_trader_lookup);
criterion_main!(benches);
