# <div align="center"> Intelligent Elevator Monitoring System</div>

<div align="center">

### A full-stack smart surveillance platform for elevator safety, personnel recognition, and event monitoring

<br/>

![React](https://img.shields.io/badge/Frontend-React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Flask](https://img.shields.io/badge/Backend-Flask-000000?style=for-the-badge&logo=flask&logoColor=white)
![Python](https://img.shields.io/badge/Language-Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![C++](https://img.shields.io/badge/Core-C%2B%2B-00599C?style=for-the-badge&logo=c%2B%2B&logoColor=white)
![MongoDB](https://img.shields.io/badge/Database-MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)

</div>

---

## 📌 Overview

**Intelligent Elevator Monitoring System** is a full-stack software project designed to enhance elevator security and operational safety through **computer vision**, **personnel recognition**, **event logging**, and **real-time alert detection**.

This system combines a **React frontend**, a **Flask backend**, and a **C++ secure core module** to deliver a monitoring platform that is both practical and scalable.  
To improve protection of critical business logic, sensitive processing functions are implemented in **native C++** and exposed to Python through a compiled **`.pyd` extension module**.

---

## ✨ Key Features

### 🔍 Real-Time Monitoring
- Monitor elevator-related activities through camera input
- Display processed information through an interactive dashboard
- Support continuous observation and event tracking

### 👤 Personnel Recognition
- Recognize registered personnel
- Manage personnel records and metadata
- Associate recognized identities with elevator events

### 📝 Event Logging
- Record event history with timestamps and related attributes
- Store structured logs for traceability and later analysis
- Support systematic review of elevator activity

### 🚨 Safety Alert Detection
- Detect abnormal situations and safety-related incidents
- Generate alerts for suspicious or high-risk conditions
- Improve situational awareness in restricted environments

### 🔐 Secure Core Processing
- Protect important logic by moving it into a native C++ module
- Reduce direct exposure of sensitive implementation details
- Bridge Python and C++ using **pybind11**

---

## 🏗️ System Architecture

```text
+------------------+        +------------------+        +----------------------+
|   React Frontend | <----> |   Flask Backend  | <----> |  C++ Secure Core     |
| Dashboard / UI   |        | API / Services   |        | .pyd Native Module   |
+------------------+        +------------------+        +----------------------+
         |                           |                            |
         |                           |                            |
         v                           v                            v
                 +--------------------------------------+
                 |              MongoDB                 |
                 | Personnel Data / Event Logs / Alerts |
                 +--------------------------------------+