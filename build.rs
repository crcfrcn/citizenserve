//! 从显式交付的SDK协议和官方protoc生成Rust类型，不使用资源回执或固定工作现场。
use std::{env, fs, path::PathBuf};
fn main() {
    for key in ["TATACHATSDK_PROTOCOL_DIR", "PROTOC"] { println!("cargo:rerun-if-env-changed={key}"); }
    let protocol = PathBuf::from(env::var_os("TATACHATSDK_PROTOCOL_DIR").expect("缺少SDK协议目录"));
    let protoc = PathBuf::from(env::var_os("PROTOC").expect("缺少官方protoc"));
    assert!(protocol.is_absolute() && protocol.is_dir(), "协议必须为绝对目录");
    assert!(protoc.is_absolute() && protoc.is_file(), "protoc必须为绝对文件");
    let mut inputs: Vec<_> = fs::read_dir(&protocol).expect("读取协议目录")
        .map(|entry| entry.expect("协议条目").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "proto")).collect();
    inputs.sort(); assert!(!inputs.is_empty(), "SDK协议为空");
    for path in &inputs { println!("cargo:rerun-if-changed={}", path.display()); }
    println!("cargo:rerun-if-changed={}", protoc.display());
    prost_build::Config::new().protoc_executable(protoc)
        .compile_protos(&inputs, &[protocol]).expect("从唯一SDK协议生成Rust类型");
}
