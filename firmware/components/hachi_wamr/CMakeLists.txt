if(NOT CMAKE_BUILD_EARLY_EXPANSION)
  include("${CMAKE_CURRENT_LIST_DIR}/wamr-options.cmake")
  set(WAMR_ROOT "$ENV{WAMR_ROOT}")
  set(WAMR_ROOT_DIR "${WAMR_ROOT}")
  set(WAMR_BUILD_TARGET RISCV32_ILP32F)
  set(WAMR_BUILD_PLATFORM esp-idf)
  include("${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake")
  list(APPEND wamr_sources ${WAMR_RUNTIME_LIB_SOURCE} ${PLATFORM_SHARED_SOURCE})
  list(REMOVE_DUPLICATES wamr_sources)
endif()

idf_component_register(
  SRCS "hachi_runtime.c" ${wamr_sources}
  INCLUDE_DIRS "." "${IWASM_DIR}/include"
  REQUIRES pthread lwip esp_timer
)
target_compile_options(${COMPONENT_LIB} PRIVATE "-Wno-format" "-Os")
if(NOT "$ENV{PET_P4_MIRUI_STACK_ARCHIVE}" STREQUAL "")
  set(stack_archive "$ENV{PET_P4_MIRUI_STACK_ARCHIVE}")
  if(NOT IS_ABSOLUTE "${stack_archive}" OR NOT EXISTS "${stack_archive}")
    message(FATAL_ERROR "PET_P4_MIRUI_STACK_ARCHIVE must point to the built RISC-V archive")
  endif()
  add_prebuilt_library(pet_mirui_stack "${stack_archive}")
  target_compile_definitions(${COMPONENT_LIB} PUBLIC HACHI_STACK_ENABLED=1)
  target_link_libraries(${COMPONENT_LIB} PRIVATE pet_mirui_stack)
endif()
