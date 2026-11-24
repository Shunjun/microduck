//! Original XL330 hardware driver entry point.
mod bus;
pub mod config;
mod driver;
pub mod imu;

pub use bus::{DynamixelIo, replacement_target};
