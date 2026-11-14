# Replace only the affected sources in the build tree. The registry package stays intact.
idf_component_get_property(hosted_lib espressif__esp_hosted COMPONENT_LIB)
idf_component_get_property(hosted_dir espressif__esp_hosted COMPONENT_DIR)

function(pet_hosted_replace relative_path original replacement)
  set(source "${hosted_dir}/${relative_path}")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${source}")
  file(READ "${source}" contents)
  string(FIND "${contents}" "${original}" position)
  if(position EQUAL -1)
    message(FATAL_ERROR "ESP-Hosted 1.4.7 startup fix no longer matches ${relative_path}")
  endif()
  string(REPLACE "${original}" "${replacement}" contents "${contents}")
  set(output "${CMAKE_CURRENT_BINARY_DIR}/hosted-startup/${relative_path}")
  file(CONFIGURE OUTPUT "${output}" CONTENT "${contents}" @ONLY)
  get_target_property(sources ${hosted_lib} SOURCES)
  set(updated)
  set(matches 0)
  foreach(item IN LISTS sources)
    get_filename_component(path "${item}" ABSOLUTE BASE_DIR "${hosted_dir}")
    if(path STREQUAL source)
      list(APPEND updated "${output}")
      math(EXPR matches "${matches} + 1")
    else()
      list(APPEND updated "${item}")
    endif()
  endforeach()
  if(NOT matches EQUAL 1)
    message(FATAL_ERROR "Expected one ${relative_path} on the ESP-Hosted target")
  endif()
  set_property(TARGET ${hosted_lib} PROPERTY SOURCES "${updated}")
endfunction()

# A FreeRTOS task cannot return to its caller on this target.
pet_hosted_replace(host/drivers/transport/sdio/sdio_drv.c
  "ESP_LOGE(TAG, \"sdio card init failed\");\n\t\treturn;"
  "ESP_LOGE(TAG, \"sdio card init failed\");\n\t\tvTaskDelete(NULL);\n\t\treturn;")

# The BLE task handles a failed startup. Let it receive the driver's error.
pet_hosted_replace(host/api/src/esp_hosted_api.c
  "ESP_ERROR_CHECK(transport_drv_reconfigure());\n\treturn ESP_OK;"
  "return transport_drv_reconfigure();")
