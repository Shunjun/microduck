//! HD1910 + IMU firmware-1.0.0 hardware driver entry point.
//Compatible: independent Feetech backend; opening it performs read-only checks.
pub mod bus;
pub mod config;
pub mod debug;
mod driver;
pub mod feedback;
pub mod imu;

pub use bus::{Feedback, FeetechBus, RegisterBus, SerialBus};
pub use config::{Config, JointCalibration};
pub use driver::FeetechIo;
pub use feedback::ServoFeedback;

fn fail(message: impl Into<String>) -> crate::io::IoError {
    crate::io::IoError::Bus(message.into())
}

#[cfg(test)]
mod tests;
